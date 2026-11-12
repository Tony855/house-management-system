'use strict';

const { createPlatformPool } = require('../../server/platform-db');
const { createPlatformApi } = require('./app');
const { createPlatformAdminAuthDependencies } = require('./admin-auth-dependencies');
const { createTenantDataMigrationExecutor } = require('../../server/tenant-data-migration-executor');

/** Production composition boundary; KMS/HSM and key providers are injected by deployment. */
function createPlatformApiRuntime({
  env = process.env, createPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
  signingKeyProvider, verificationKeyProvider, issuer, authOptions,
  migrationConnectionResolver, migrationWorkerId, migrationConcurrency
} = {}) {
  if (!mfaEncryption || !signingKeyProvider || !verificationKeyProvider) throw new TypeError('PLATFORM_SECURITY_DEPENDENCIES_REQUIRED');
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
    let closed = false;
    return Object.freeze({
      app, pool: platformPool, auth,
      async close() {
        if (closed) return;
        closed = true;
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
