'use strict';

const { createProductAuthenticator } = require('./product-auth');
const {
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createTenantDatabaseSecretProvider
} = require('./platform-adapters');
const { TenantPoolManager } = require('./tenant-db');
const mysql = require('mysql2/promise');

function createProductControlPlaneDependencies({
  appId,
  issuer,
  platformPool,
  secretManager,
  keyProvider,
  poolManager,
  createPool = mysql.createPool,
  authOptions = {}
}) {
  if (!['rental', 'hotel', 'property'].includes(appId)) throw new TypeError('PRODUCT_AUTH_APP_ID_INVALID');
  if (!platformPool || typeof platformPool.query !== 'function') throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  const resolvedPoolManager = poolManager || new TenantPoolManager({ createPool });
  if (typeof resolvedPoolManager.getPool !== 'function') throw new TypeError('PRODUCT_POOL_MANAGER_REQUIRED');

  return Object.freeze({
    authenticate: createProductAuthenticator({
      appId,
      issuer,
      keyProvider,
      sessionStore: createPlatformProductSessionStore(platformPool),
      ...authOptions
    }),
    registry: createPlatformTenantRegistry(platformPool),
    secretProvider: createTenantDatabaseSecretProvider(secretManager),
    poolManager: resolvedPoolManager
  });
}

module.exports = { createProductControlPlaneDependencies };
