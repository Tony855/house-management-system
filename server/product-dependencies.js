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

  const authConfig = {
    appId,
    issuer,
    keyProvider,
    sessionStore: createPlatformProductSessionStore(platformPool)
  };
  if (authOptions.now !== undefined) authConfig.now = authOptions.now;
  if (authOptions.clockSkewSeconds !== undefined) authConfig.clockSkewSeconds = authOptions.clockSkewSeconds;
  if (authOptions.maxLifetimeSeconds !== undefined) authConfig.maxLifetimeSeconds = authOptions.maxLifetimeSeconds;

  return Object.freeze({
    authenticate: createProductAuthenticator(authConfig),
    registry: createPlatformTenantRegistry(platformPool),
    secretProvider: createTenantDatabaseSecretProvider(secretManager),
    poolManager: resolvedPoolManager
  });
}

module.exports = { createProductControlPlaneDependencies };
