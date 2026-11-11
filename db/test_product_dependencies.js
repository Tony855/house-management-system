'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductControlPlaneDependencies } = require('../server/product-dependencies');

test('product dependencies wire signed auth, platform registry, session revocation and secret manager', () => {
  const pool = { query: async () => [[], []], getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[], []], commit: async () => {}, rollback: async () => {}, release: () => {} }) };
  const dependencies = createProductControlPlaneDependencies({
    appId: 'rental',
    issuer: 'https://auth.example.test',
    platformPool: pool,
    secretManager: { getSecret: async () => ({ user: 'tenant', password: 'secret' }) },
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' },
    poolManager: { getPool: async () => ({}) }
  });
  assert.equal(typeof dependencies.authenticate, 'function');
  assert.equal(typeof dependencies.registry.findTenantById, 'function');
  assert.equal(typeof dependencies.secretProvider.getDatabaseCredentials, 'function');
  assert.equal(typeof dependencies.poolManager.getPool, 'function');
  assert.equal(dependencies.loginService, undefined);
  assert.equal(Object.isFrozen(dependencies), true);
});

test('product dependency composition refuses incomplete control-plane integrations', () => {
  assert.throws(() => createProductControlPlaneDependencies({
    appId: 'rental', issuer: 'issuer', platformPool: null,
    secretManager: { getSecret: async () => ({}) },
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' }
  }), /PLATFORM_DB_POOL_REQUIRED/);
  assert.throws(() => createProductControlPlaneDependencies({
    appId: 'rental', issuer: 'issuer', platformPool: { query: async () => [[], []] },
    secretManager: null,
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' }
  }), /TENANT_SECRET_MANAGER_REQUIRED/);
});

test('product dependencies wire login only with a dedicated signing key issuer', () => {
  const pool = { query: async () => [[], []], getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[], []], commit: async () => {}, rollback: async () => {}, release: () => {} }) };
  const dependencies = createProductControlPlaneDependencies({
    appId: 'hotel',
    issuer: 'https://auth.example.test',
    platformPool: pool,
    secretManager: { getSecret: async () => ({ user: 'tenant', password: 'secret' }) },
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' },
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'v1', key: '0123456789abcdef0123456789abcdef' }) },
    loginRateLimitHmacKey: '0123456789abcdef0123456789abcdef',
    poolManager: { getPool: async () => ({ execute: async () => [[], []] }) }
  });
  assert.equal(typeof dependencies.loginService.login, 'function');
  assert.equal(typeof dependencies.loginService.logout, 'function');
});

test('product login composition refuses to enable login without a dedicated limiter HMAC key', () => {
  const pool = { query: async () => [[], []], getConnection: async () => ({}) };
  assert.throws(() => createProductControlPlaneDependencies({
    appId: 'rental', issuer: 'https://auth.example.test', platformPool: pool,
    secretManager: { getSecret: async () => ({ user: 'tenant', password: 'secret' }) },
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' },
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'v1', key: '0123456789abcdef0123456789abcdef' }) }
  }), /LOGIN_RATE_LIMIT_HMAC_KEY_REQUIRED/);
});
