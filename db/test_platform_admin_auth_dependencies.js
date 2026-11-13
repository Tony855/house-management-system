'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformAdminAuthDependencies } = require('../services/platform-api/admin-auth-dependencies');

function config(overrides = {}) {
  return {
    platformPool: { query: async () => [[], []], getConnection: async () => { throw new Error('not used'); } },
    mfaEncryption: {
      encrypt: async value => ({ ciphertext: Buffer.from(value).toString('base64') }),
      decrypt: async value => Buffer.from(value.ciphertext, 'base64')
    },
    recoveryCodePepper: 'platform-recovery-code-pepper-at-least-32-bytes',
    loginRateLimitHmacKey: 'platform-login-rate-limit-hmac-key-at-least-32-bytes',
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'key-1', key: 'platform-signing-key-at-least-32-bytes-long' }) },
    verificationKeyProvider: { getVerificationKey: async () => 'platform-signing-key-at-least-32-bytes-long' },
    issuer: 'https://platform.example.test',
    ...overrides
  };
}

test('platform admin auth composition wires platform DB stores, KMS, keys and isolated limiter', () => {
  const dependencies = createPlatformAdminAuthDependencies(config());
  assert.equal(typeof dependencies.authService.login, 'function');
  assert.equal(typeof dependencies.authService.verifyChallenge, 'function');
  assert.equal(typeof dependencies.authService.authenticate, 'function');
  assert.equal(typeof dependencies.authService.stepUp, 'function');
  assert.equal(typeof dependencies.authService.logout, 'function');
  assert.equal(typeof dependencies.loginRateLimiter.assertAllowed, 'function');
});

test('platform admin auth composition refuses missing KMS, recovery pepper, HMAC key or key providers', () => {
  assert.throws(() => createPlatformAdminAuthDependencies(config({ mfaEncryption: null })), /PLATFORM_MFA_ENCRYPTION_REQUIRED/);
  assert.throws(() => createPlatformAdminAuthDependencies(config({ recoveryCodePepper: 'short' })), /PLATFORM_MFA_RECOVERY_PEPPER_REQUIRED/);
  assert.throws(() => createPlatformAdminAuthDependencies(config({ loginRateLimitHmacKey: 'short' })), /LOGIN_RATE_LIMIT_HMAC_KEY_REQUIRED/);
  assert.throws(() => createPlatformAdminAuthDependencies(config({ signingKeyProvider: null })), /PLATFORM_ADMIN_KEY_PROVIDER_REQUIRED/);
});
