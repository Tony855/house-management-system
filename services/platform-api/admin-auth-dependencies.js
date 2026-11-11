'use strict';

const { createPlatformLoginRateLimiter } = require('../../server/platform-adapters');
const { createPlatformAdminAuthStore } = require('./admin-auth-store');
const { createPlatformAdminMfaStore } = require('./mfa-store');
const { createPlatformAdminAuditStore } = require('./admin-audit-store');
const { createPlatformMfaService } = require('./mfa');
const { createPlatformAdminAuthService } = require('./admin-auth');

function createPlatformAdminAuthDependencies({
  platformPool, mfaEncryption, recoveryCodePepper, loginRateLimitHmacKey,
  signingKeyProvider, verificationKeyProvider, issuer, authOptions = {}
}) {
  if (!platformPool || typeof platformPool.query !== 'function') throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  if (!mfaEncryption || typeof mfaEncryption.encrypt !== 'function' || typeof mfaEncryption.decrypt !== 'function') {
    throw new TypeError('PLATFORM_MFA_ENCRYPTION_REQUIRED');
  }
  if (!(typeof recoveryCodePepper === 'string' || Buffer.isBuffer(recoveryCodePepper)) || Buffer.byteLength(recoveryCodePepper) < 32) {
    throw new TypeError('PLATFORM_MFA_RECOVERY_PEPPER_REQUIRED');
  }
  if (!(typeof loginRateLimitHmacKey === 'string' || Buffer.isBuffer(loginRateLimitHmacKey)) || Buffer.byteLength(loginRateLimitHmacKey) < 32) {
    throw new TypeError('LOGIN_RATE_LIMIT_HMAC_KEY_REQUIRED');
  }
  if (!signingKeyProvider || typeof signingKeyProvider.getSigningKey !== 'function' ||
      !verificationKeyProvider || typeof verificationKeyProvider.getVerificationKey !== 'function') {
    throw new TypeError('PLATFORM_ADMIN_KEY_PROVIDER_REQUIRED');
  }
  if (typeof issuer !== 'string' || !issuer) throw new TypeError('PLATFORM_AUTH_ISSUER_REQUIRED');

  const authStore = createPlatformAdminAuthStore(platformPool);
  const auditStore = createPlatformAdminAuditStore(platformPool);
  const mfaService = createPlatformMfaService({
    store: createPlatformAdminMfaStore(platformPool), encryption: mfaEncryption, recoveryCodePepper,
    ...(authOptions.now ? { now: authOptions.now } : {})
  });
  const loginRateLimiter = createPlatformLoginRateLimiter(platformPool, {
    hmacKey: loginRateLimitHmacKey, ...(authOptions.loginRateLimit || {})
  });
  const authService = createPlatformAdminAuthService({
    adminStore: authStore, challengeStore: authStore, sessionStore: authStore, mfaService,
    signingKeyProvider, verificationKeyProvider, issuer, loginRateLimiter,
    ...(authOptions.verifyPassword ? { verifyPassword: authOptions.verifyPassword } : {}),
    ...(authOptions.now ? { now: authOptions.now } : {}),
    ...(authOptions.sessionLifetimeSeconds ? { sessionLifetimeSeconds: authOptions.sessionLifetimeSeconds } : {}),
    ...(authOptions.challengeLifetimeSeconds ? { challengeLifetimeSeconds: authOptions.challengeLifetimeSeconds } : {}),
    ...(authOptions.stepUpFreshSeconds ? { stepUpFreshSeconds: authOptions.stepUpFreshSeconds } : {})
  });
  return Object.freeze({ authService, authStore, mfaService, loginRateLimiter, auditStore });
}

module.exports = { createPlatformAdminAuthDependencies };
