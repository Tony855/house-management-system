'use strict';

const { createPlatformPool } = require('../../server/platform-db');
const { createPlatformApi } = require('./app');
const { createPlatformAdminAuthDependencies } = require('./admin-auth-dependencies');
const { createTenantDataMigrationExecutor } = require('../../server/tenant-data-migration-executor');
const mysql = require('mysql2/promise');
const { TenantPoolManager } = require('../../server/tenant-db');
const { createPlatformTenantRegistry, createTenantDatabaseSecretProvider } = require('../../server/platform-adapters');
const { createRecurringBillingDispatchStore } = require('../../server/recurring-billing-dispatch-store');
const { createRecurringBillingDispatcher } = require('../../server/recurring-billing-dispatcher');
const { createRecurringBillingTenantAdapter } = require('../../server/recurring-billing-tenant-adapter');
const { createRecurringBillingRunner } = require('../../server/recurring-billing-runner');
const { createTenantBillingJobWorker } = require('../../server/tenant-billing-job-worker');
const { createTenantBillingJobProcessor } = require('../../server/tenant-billing-job-processor');

/** Production composition boundary; KMS/HSM and key providers are injected by deployment. */
function createPlatformApiRuntime({
  env = process.env, createPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
  signingKeyProvider, verificationKeyProvider, issuer, authOptions,
  migrationConnectionResolver, migrationWorkerId, migrationConcurrency,
  tenantSecretManager, tenantPoolCreatePool = mysql.createPool, billingWorkerId, billingPollIntervalMs, billingJobWorker, billingSystemWriteAuthorizer, billingSchedulerEnabled = env.BILLING_SCHEDULER_ENABLED === 'true', billingJobWorkerEnabled = env.BILLING_JOB_WORKER_ENABLED === 'true', billingJobWorkerConcurrency = 4, billingJobLeaseSeconds = Number(env.BILLING_JOB_LEASE_SECONDS || 600), billingJobChunkSize = Number(env.BILLING_JOB_CHUNK_SIZE || 50)
} = {}) {
  if (!mfaEncryption || !signingKeyProvider || !verificationKeyProvider) throw new TypeError('PLATFORM_SECURITY_DEPENDENCIES_REQUIRED');
  if (billingJobWorker && (tenantSecretManager === undefined || typeof billingJobWorker.start !== 'function' || typeof billingJobWorker.stop !== 'function')) throw new TypeError('PLATFORM_BILLING_JOB_WORKER_DEPENDENCIES_REQUIRED');
  if ((billingSchedulerEnabled || billingJobWorkerEnabled || billingJobWorker) &&
      (tenantSecretManager === undefined || typeof billingSystemWriteAuthorizer !== 'function')) {
    throw new TypeError('PLATFORM_BILLING_SYSTEM_AUTHORIZER_REQUIRED');
  }
  if (billingSystemWriteAuthorizer !== undefined && (tenantSecretManager === undefined || typeof billingSystemWriteAuthorizer !== 'function')) throw new TypeError('PLATFORM_BILLING_SYSTEM_AUTHORIZER_REQUIRED');
  const platformPool = createPlatformPool({ env, ...(createPool ? { createPool } : {}) });
  try {
    const auth = createPlatformAdminAuthDependencies({
      platformPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
      signingKeyProvider, verificationKeyProvider, issuer, authOptions
    });
    const migrationExecutor = migrationConnectionResolver === undefined ? undefined :
      createTenantDataMigrationExecutor({ resolveConnections: migrationConnectionResolver });
    const app = createPlatformApi({
      pool: platformPool, adminAuthService: auth.authService,
      mfaService: auth.mfaService, auditStore: auth.auditStore, adminStore: auth.authStore,
      ...(migrationExecutor ? { migrationExecutor } : {}),
      ...(migrationWorkerId ? { migrationWorkerId } : {}),
      ...(migrationConcurrency ? { migrationConcurrency } : {})
    });
    let tenantPoolManager = null;
    let tenantRegistry = null;
    let tenantSecretProvider = null;
    let recurringBillingRunner = null;
    let tenantBillingJobWorker = null;
    if ((billingSchedulerEnabled || billingJobWorkerEnabled) && tenantSecretManager !== undefined && typeof billingSystemWriteAuthorizer === 'function') {
      const registry = createPlatformTenantRegistry(platformPool);
      const secretProvider = createTenantDatabaseSecretProvider(tenantSecretManager);
      tenantRegistry = registry;
      tenantSecretProvider = secretProvider;
      tenantPoolManager = new TenantPoolManager({ createPool: tenantPoolCreatePool, maxPools: 100, idleTtlMs: 300000 });
      const tenantAdapter = createRecurringBillingTenantAdapter({ registry, secretProvider, tenantPoolManager });
      const dispatchStore = createRecurringBillingDispatchStore(platformPool);
      const dispatcher = createRecurringBillingDispatcher({
        store: dispatchStore,
        workerId: billingWorkerId || env.BILLING_WORKER_ID || 'platform-billing-worker',
        enqueueTenantJob: input => tenantAdapter.enqueueTenantJob(input)
      });
      if (billingSchedulerEnabled) {
        recurringBillingRunner = createRecurringBillingRunner({
          store: dispatchStore, dispatcher,
          workerId: billingWorkerId || env.BILLING_WORKER_ID || 'platform-billing-worker',
          pollIntervalMs: billingPollIntervalMs || Number(env.BILLING_POLL_INTERVAL_MS || 60000),
          onError: event => {
            if (typeof env.BILLING_RUNNER_ON_ERROR === 'function') env.BILLING_RUNNER_ON_ERROR(event);
          }
        });
        recurringBillingRunner.start();
        app.locals.recurringBillingRunner = recurringBillingRunner;
        app.locals.stopRecurringBillingRunner = () => recurringBillingRunner.stop();
      } else {
        app.locals.stopRecurringBillingRunner = async () => {};
      }
    } else {
      app.locals.stopRecurringBillingRunner = async () => {};
    }
    if (billingJobWorker) {
      tenantBillingJobWorker = billingJobWorker;
      tenantBillingJobWorker.start();
      app.locals.tenantBillingJobWorker = tenantBillingJobWorker;
      app.locals.stopTenantBillingJobWorker = () => tenantBillingJobWorker.stop();
    } else if (billingJobWorkerEnabled && tenantRegistry && tenantSecretProvider && billingSystemWriteAuthorizer) {
      const processor = createTenantBillingJobProcessor({
        registry: tenantRegistry, secretProvider: tenantSecretProvider,
        tenantPoolManager, authorizeSystem: billingSystemWriteAuthorizer,
        leaseSeconds: billingJobLeaseSeconds, chunkSize: billingJobChunkSize
      });
      tenantBillingJobWorker = createTenantBillingJobWorker({
        workerId: billingWorkerId || env.BILLING_WORKER_ID || 'platform-billing-worker',
        pollIntervalMs: billingPollIntervalMs || Number(env.BILLING_POLL_INTERVAL_MS || 5000),
        concurrency: billingJobWorkerConcurrency,
        processNextBatch: input => processor.processNextBatch(input),
        onError: event => { if (typeof env.BILLING_RUNNER_ON_ERROR === 'function') env.BILLING_RUNNER_ON_ERROR(event); }
      });
      tenantBillingJobWorker.start();
      app.locals.tenantBillingJobWorker = tenantBillingJobWorker;
      app.locals.tenantBillingJobProcessor = processor;
      app.locals.stopTenantBillingJobWorker = () => tenantBillingJobWorker.stop();
    } else {
      app.locals.stopTenantBillingJobWorker = async () => {};
    }
    let closed = false;
    return Object.freeze({
      app, pool: platformPool, auth,
      async close() {
        if (closed) return;
        closed = true;
        if (typeof app.locals.stopRecurringBillingRunner === 'function') await app.locals.stopRecurringBillingRunner();
        if (typeof app.locals.stopTenantBillingJobWorker === 'function') await app.locals.stopTenantBillingJobWorker();
        if (tenantPoolManager) await tenantPoolManager.closeAll();
        if (typeof app.locals.stopTenantMigrationRunner === 'function') await app.locals.stopTenantMigrationRunner();
        if (typeof platformPool.end === 'function') await platformPool.end();
      }
    });
  } catch (error) {
    if (typeof platformPool.end === 'function') {
      try { Promise.resolve(platformPool.end()).catch(() => {}); } catch (_) { /* preserve startup failure */ }
    }
    throw error;
  }
}

module.exports = { createPlatformApiRuntime };
