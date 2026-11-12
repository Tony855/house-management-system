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
