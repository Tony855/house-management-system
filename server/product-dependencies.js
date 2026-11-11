'use strict';

const { createProductAuthenticator } = require('./product-auth');
const { createProductLoginService } = require('./product-login');
const {
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createPlatformLoginRateLimiter,
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
  signingKeyProvider,
  loginRateLimitHmacKey,
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

  const registry = createPlatformTenantRegistry(platformPool);
  const secretProvider = createTenantDatabaseSecretProvider(secretManager);
  const dependencies = {
    authenticate: createProductAuthenticator(authConfig),
    registry,
    secretProvider,
    poolManager: resolvedPoolManager
  };
  // Login is exposed only when a separate signing-key issuer is explicitly configured.
  // Verification-only key providers must never be repurposed to mint access tokens.
  if (signingKeyProvider !== undefined) {
    dependencies.loginService = createProductLoginService({
      appId, issuer, registry, secretProvider, poolManager: resolvedPoolManager,
      sessionStore: createPlatformProductSessionStore(platformPool), signingKeyProvider,
      loginRateLimiter: createPlatformLoginRateLimiter(platformPool, { hmacKey: loginRateLimitHmacKey })
    });
  }
  return Object.freeze(dependencies);
}

module.exports = { createProductControlPlaneDependencies };
