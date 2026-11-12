'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductApiRuntime } = require('../server/product-runtime');

function makePool() {
  return {
    ended: 0,
    query: async () => [[], []],
    getConnection: async () => ({
      beginTransaction: async () => {}, query: async () => [[], []],
      commit: async () => {}, rollback: async () => {}, release: () => {}
    }),
    end: async function () { this.ended++; }
  };
}
const env = {
  PLATFORM_DB_HOST: '127.0.0.1', PLATFORM_DB_NAME: 'platform_control',
  PLATFORM_DB_USER: 'product_api', PLATFORM_DB_PASSWORD: 'strong-password',
  PLATFORM_DB_PORT: '3306', PLATFORM_DB_POOL_SIZE: '5'
};
function providers() {
  return {
    secretManager: { getSecret: async () => ({ user: 'tenant', password: 'tenant-password' }) },
    keyProvider: { getVerificationKey: async () => '0123456789abcdef0123456789abcdef' },
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'product-v1', key: '0123456789abcdef0123456789abcdef' }) },
    loginRateLimitHmacKey: '0123456789abcdef0123456789abcdef',
    issuer: 'https://auth.example.test'
  };
}
test('product runtime composes a product-specific API and closes its dedicated platform pool', async () => {
  const pool = makePool();
  const runtime = createProductApiRuntime({ appId: 'rental', env, createPool: () => pool, ...providers() });
  assert.equal(typeof runtime.app, 'function');
  assert.equal(typeof runtime.dependencies.authenticate, 'function');
  assert.equal(typeof runtime.dependencies.loginService.login, 'function');
  await runtime.close();
  await runtime.close();
  assert.equal(pool.ended, 1);
});
test('product runtime rejects unknown app and incomplete security providers', () => {
  assert.throws(() => createProductApiRuntime({ appId: 'platform', env, ...providers() }), /PRODUCT_RUNTIME_APP_INVALID/);
  assert.throws(() => createProductApiRuntime({ appId: 'hotel', env, createPool: makePool, issuer: 'issuer' }), /TENANT_SECRET_MANAGER_REQUIRED/);
});
