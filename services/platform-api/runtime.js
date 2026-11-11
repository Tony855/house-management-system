'use strict';

const { createPlatformPool } = require('../../server/platform-db');
const { createPlatformApi } = require('./app');
const { createPlatformAdminAuthDependencies } = require('./admin-auth-dependencies');

/** Production composition boundary; KMS/HSM and key providers are injected by deployment. */
function createPlatformApiRuntime({
  env = process.env, createPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
  signingKeyProvider, verificationKeyProvider, issuer, authOptions
} = {}) {
  if (!mfaEncryption || !signingKeyProvider || !verificationKeyProvider) throw new TypeError('PLATFORM_SECURITY_DEPENDENCIES_REQUIRED');
  const platformPool = createPlatformPool({ env, ...(createPool ? { createPool } : {}) });
  try {
    const auth = createPlatformAdminAuthDependencies({
      platformPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
      signingKeyProvider, verificationKeyProvider, issuer, authOptions
    });
    const app = createPlatformApi({
      pool: platformPool, adminAuthService: auth.authService,
      mfaService: auth.mfaService, auditStore: auth.auditStore, adminStore: auth.authStore
    });
    let closed = false;
    return Object.freeze({
      app, pool: platformPool, auth,
      async close() {
        if (closed) return;
        closed = true;
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
