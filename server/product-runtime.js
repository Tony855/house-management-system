'use strict';

const mysql = require('mysql2/promise');
const { createPlatformPool } = require('./platform-db');
const { createProductControlPlaneDependencies } = require('./product-dependencies');
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
  loginRateLimitHmacKey, writeSecurity, authOptions, poolManager
} = {}) {
  const factory = FACTORIES[appId];
  if (!factory) throw new TypeError('PRODUCT_RUNTIME_APP_INVALID');
  const platformPool = createPlatformPool({ env, createPool });
  let dependencies;
  let closed = false;
  try {
    dependencies = createProductControlPlaneDependencies({
      appId, issuer, platformPool, secretManager, keyProvider,
      signingKeyProvider, loginRateLimitHmacKey, writeSecurity,
      authOptions, poolManager, createPool
    });
    dependencies = Object.freeze({
      ...dependencies,
      readinessCheck: async () => {
        if (closed || typeof platformPool.query !== 'function') return false;
        await platformPool.query('SELECT 1');
        return true;
      }
    });
    const app = factory(dependencies);
    return Object.freeze({
      app, pool: platformPool, dependencies,
      async close() {
        if (closed) return;
        closed = true;
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
