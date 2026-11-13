'use strict';

const mysql = require('mysql2/promise');
const { createPlatformPool } = require('./platform-db');
const { createProductControlPlaneDependencies } = require('./product-dependencies');
const { createTenantBillingJobProcessor } = require('./tenant-billing-job-processor');
const { createTenantBillingJobWorker } = require('./tenant-billing-job-worker');
const { createRentalApi } = require('../services/rental-api/app');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');

const FACTORIES = Object.freeze({
  rental: createRentalApi,
  hotel: createHotelApi,
  property: createPropertyApi
});

/**
 * Production composition root for one isolated product API process.
 * Platform credentials/providers are injected; no legacy DB or default-secret
 * fallback is permitted. Tenant pools are closed during graceful shutdown.
 */
function createProductApiRuntime({
  appId, env = process.env, createPool = mysql.createPool,
  secretManager, keyProvider, signingKeyProvider, issuer,
  loginRateLimitHmacKey, writeSecurity, authOptions, poolManager, billingWorker
} = {}) {
  const factory = FACTORIES[appId];
  if (!factory) throw new TypeError('PRODUCT_RUNTIME_APP_INVALID');
  const platformPool = createPlatformPool({ env, createPool });
  let dependencies;
  try {
    dependencies = createProductControlPlaneDependencies({
      appId, issuer, platformPool, secretManager, keyProvider,
      signingKeyProvider, loginRateLimitHmacKey, writeSecurity,
      authOptions, poolManager, createPool
    });
    const app = factory(dependencies);
    let worker = null;
    if (billingWorker?.enabled === true) {
      if (!['rental','property'].includes(appId) || typeof billingWorker.authorizeSystem !== 'function') throw new TypeError('PRODUCT_BILLING_WORKER_SECURITY_REQUIRED');
      const workerId = billingWorker.workerId || env.TENANT_BILLING_WORKER_ID;
      const processor = createTenantBillingJobProcessor({ registry: dependencies.registry, secretProvider: dependencies.secretProvider, tenantPoolManager: dependencies.poolManager, authorizeSystem: billingWorker.authorizeSystem, appIds: [appId], leaseSeconds: billingWorker.leaseSeconds, chunkSize: billingWorker.chunkSize });
      worker = createTenantBillingJobWorker({ workerId, processNextBatch: processor.processNextBatch, pollIntervalMs: billingWorker.pollIntervalMs, concurrency: billingWorker.concurrency, onError: billingWorker.onError });
      worker.start();
    }
    let closed = false;
    return Object.freeze({
      app, pool: platformPool, dependencies, billingWorker: worker,
      async close() {
        if (closed) return;
        closed = true;
        if (worker) await worker.stop();
        if (dependencies.poolManager && typeof dependencies.poolManager.closeAll === 'function') {
          await dependencies.poolManager.closeAll();
        }
        if (typeof platformPool.end === 'function') await platformPool.end();
      }
    });
  } catch (error) {
    if (dependencies?.poolManager && typeof dependencies.poolManager.closeAll === 'function') {
      try { Promise.resolve(dependencies.poolManager.closeAll()).catch(() => {}); } catch (_) {}
    }
    if (typeof platformPool.end === 'function') {
      try { Promise.resolve(platformPool.end()).catch(() => {}); } catch (_) {}
    }
    throw error;
  }
}

module.exports = { createProductApiRuntime };
