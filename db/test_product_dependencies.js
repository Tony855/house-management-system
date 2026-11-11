'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductControlPlaneDependencies } = require('../server/product-dependencies');

test('product dependencies wire signed auth, platform registry, session revocation and secret manager', () => {
  const pool = { query: async () => [[], []] };
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
