'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformApiRuntime } = require('../services/platform-api/runtime');

function options(overrides = {}) {
  let poolConfig;
  const pool = {
    ended: 0,
    query: async () => [[], []],
    getConnection: async () => { throw new Error('not used'); },
    end: async function () { this.ended++; }
  };
  const config = {
    env: {
      PLATFORM_DB_HOST: '127.0.0.1', PLATFORM_DB_NAME: 'platform_control',
      PLATFORM_DB_USER: 'platform_api', PLATFORM_DB_PASSWORD: 'strong-db-password',
      PLATFORM_DB_PORT: '3306', PLATFORM_DB_POOL_SIZE: '5'
    },
    createPool: config => { poolConfig = config; return pool; },
    mfaEncryption: {
      encrypt: async value => ({ ciphertext: Buffer.from(value).toString('base64') }),
      decrypt: async value => Buffer.from(value.ciphertext, 'base64')
    },
    recoveryCodePepper: 'platform-recovery-code-pepper-at-least-32-bytes',
    loginRateLimitHmacKey: 'platform-login-rate-limit-hmac-key-at-least-32-bytes',
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'platform-key-1', key: 'platform-signing-key-at-least-32-bytes-long' }) },
    verificationKeyProvider: { getVerificationKey: async () => 'platform-signing-key-at-least-32-bytes-long' },
    issuer: 'https://platform.example.test',
    pool,
    ...overrides
  };
  Object.defineProperty(config, 'poolConfig', { get: () => poolConfig });
  return config;
}

test('platform runtime composes a dedicated DB, MFA and admin auth without legacy fallback', async () => {
  const config = options();
  const runtime = createPlatformApiRuntime(config);
  assert.equal(config.poolConfig.database, 'platform_control');
  assert.equal(config.poolConfig.user, 'platform_api');
  assert.equal(typeof runtime.app, 'function');
  assert.equal(typeof runtime.auth.authService.authenticate, 'function');
  await runtime.close();
  await runtime.close();
  assert.equal(config.pool.ended, 1);
});

test('platform runtime refuses missing KMS or key providers before creating a DB pool', () => {
  let created = false;
  assert.throws(() => createPlatformApiRuntime({
    ...options({ createPool: () => { created = true; return options().pool; } }),
    mfaEncryption: null
  }), /PLATFORM_SECURITY_DEPENDENCIES_REQUIRED/);
  assert.equal(created, false);
});

test('platform runtime closes its pool when auth dependency composition fails', () => {
  const config = options({ recoveryCodePepper: 'short' });
  assert.throws(() => createPlatformApiRuntime(config), /PLATFORM_MFA_RECOVERY_PEPPER_REQUIRED/);
  assert.equal(config.pool.ended, 1);
});

test('platform runtime refuses missing dedicated platform database settings', () => {
  assert.throws(() => createPlatformApiRuntime({
    ...options(), env: { DB_HOST: 'legacy', DB_NAME: 'house_sys', DB_USER: 'legacy', DB_PASSWORD: 'legacy' }
  }), /PLATFORM_DATABASE_CONFIGURATION_REQUIRED/);
});


test('platform runtime wires an injected tenant migration connection resolver and drains runner before DB close', async () => {
  const config = options({
    migrationConnectionResolver: async () => { throw new Error('not invoked without queued jobs'); },
    migrationWorkerId: 'runtime-migration-worker', migrationConcurrency: 1
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.tenantMigrationRunner.isRunning(), true);
  await runtime.close();
  assert.equal(runtime.app.locals.tenantMigrationRunner.isRunning(), false);
  assert.equal(config.pool.ended, 1);
});

test('platform runtime leaves migration worker disabled when no secure resolver is injected', async () => {
  const config = options();
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.tenantMigrationRunner, undefined);
  await runtime.close();
  assert.equal(config.pool.ended, 1);
});

test('platform runtime refuses to start recurring billing scheduler without system authorization', () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSchedulerEnabled: true,
    billingWorkerId: 'billing-runtime-worker',
    billingPollIntervalMs: 60000
  });
  assert.throws(() => createPlatformApiRuntime(config), /PLATFORM_BILLING_SYSTEM_AUTHORIZER_REQUIRED/);
  assert.equal(config.pool.ended, 0, 'authorization is validated before allocating the platform pool');
});

test('platform runtime enables recurring billing scheduler only with secret manager and system authorization, then drains it on shutdown', async () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSystemWriteAuthorizer: async () => true,
    billingSchedulerEnabled: true,
    billingWorkerId: 'billing-runtime-worker',
    billingPollIntervalMs: 60000
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.recurringBillingRunner.isRunning(), true);
  await runtime.close();
  assert.equal(runtime.app.locals.recurringBillingRunner.isRunning(), false);
  assert.equal(config.pool.ended, 1);
});

test('platform runtime keeps recurring billing scheduler disabled without a secret manager', async () => {
  const runtime = createPlatformApiRuntime(options());
  assert.equal(runtime.app.locals.recurringBillingRunner, undefined);
  await runtime.close();
});

test('platform runtime refuses an explicitly enabled tenant billing worker without system authorization', () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingJobWorker: { start() {}, stop: async () => {} }
  });
  assert.throws(() => createPlatformApiRuntime(config), /PLATFORM_BILLING_SYSTEM_AUTHORIZER_REQUIRED/);
  assert.equal(config.pool.ended, 0, 'authorization is validated before allocating the platform pool');
});

test('platform runtime starts an injected tenant billing worker and drains it before DB close', async () => {
  const calls = [];
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSystemWriteAuthorizer: async () => true,
    billingJobWorker: { start: () => calls.push('start'), stop: async () => calls.push('stop') }
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.tenantBillingJobWorker, config.billingJobWorker);
  assert.deepEqual(calls, ['start']);
  await runtime.close();
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(config.pool.ended, 1);
});

test('platform runtime rejects a billing worker without tenant secret manager', () => {
  assert.throws(() => createPlatformApiRuntime(options({
    billingJobWorker: { start() {}, stop: async () => {} }
  })), /PLATFORM_BILLING_JOB_WORKER_DEPENDENCIES_REQUIRED/);
});

test('platform runtime composes an automatic billing processor only with explicit machine authorization', async () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSystemWriteAuthorizer: async () => true,
    billingWorkerId: 'billing-runtime-worker',
    billingJobWorkerEnabled: true,
    billingJobWorkerConcurrency: 2
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.tenantBillingJobWorker.isRunning(), true);
  assert.equal(typeof runtime.app.locals.tenantBillingJobProcessor.processNextBatch, 'function');
  await runtime.close();
  assert.equal(runtime.app.locals.tenantBillingJobWorker.isRunning(), false);
  assert.equal(config.pool.ended, 1);
});

test('platform runtime rejects an explicitly enabled billing scheduler without system authorization before allocating resources', () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSchedulerEnabled: true
  });
  assert.throws(() => createPlatformApiRuntime(config), /PLATFORM_BILLING_SYSTEM_AUTHORIZER_REQUIRED/);
  assert.equal(config.pool.ended, 0);
});

test('platform runtime exposes configured billing lease and chunk bounds to the processor', async () => {
  const config = options({ env: { ...options().env, BILLING_JOB_LEASE_SECONDS: '900', BILLING_JOB_CHUNK_SIZE: '25' }, tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) }, billingSystemWriteAuthorizer: async () => true, billingJobWorkerEnabled: true, billingWorkerId: 'billing-runtime-worker' });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.tenantBillingJobProcessor.leaseSeconds, 900);
  assert.equal(runtime.app.locals.tenantBillingJobProcessor.chunkSize, 25);
  await runtime.close();
});


test('platform runtime keeps scheduler and processor disabled by default even when tenant credentials and authorizer exist', async () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSystemWriteAuthorizer: async () => true
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.recurringBillingRunner, undefined);
  assert.equal(runtime.app.locals.tenantBillingJobWorker, undefined);
  await runtime.close();
  assert.equal(config.pool.ended, 1);
});

test('platform runtime can enable scheduler without enabling tenant bill generation worker', async () => {
  const config = options({
    tenantSecretManager: { getSecret: async () => ({ user: 'tenant-user', password: 'tenant-password', version: 'v1' }) },
    billingSystemWriteAuthorizer: async () => true,
    billingSchedulerEnabled: true,
    billingPollIntervalMs: 60000
  });
  const runtime = createPlatformApiRuntime(config);
  assert.equal(runtime.app.locals.recurringBillingRunner.isRunning(), true);
  assert.equal(runtime.app.locals.tenantBillingJobWorker, undefined);
  await runtime.close();
  assert.equal(config.pool.ended, 1);
});
