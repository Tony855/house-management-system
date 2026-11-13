'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantMiddleware } = require('../server/tenant-middleware');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('tenant middleware exposes only stable uppercase resolver error codes', async () => {
  const res = response();
  const middleware = createTenantMiddleware({
    appId: 'rental',
    registry: { findTenantById: async () => { throw new Error('TENANT_REGISTRY_UNAVAILABLE'); } },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'u', password: 'p' }) },
    poolManager: { getPool: async () => ({ end: async () => {} }) }
  });
  await middleware({ auth: { authenticated: true, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, res, () => {
    assert.fail('next must not be called when tenant resolution fails');
  });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'TENANT_REGISTRY_UNAVAILABLE' });
});

test('tenant middleware does not leak arbitrary exception messages', async () => {
  const res = response();
  const middleware = createTenantMiddleware({
    appId: 'rental',
    registry: { findTenantById: async () => { throw new Error('password=do-not-leak'); } },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'u', password: 'p' }) },
    poolManager: { getPool: async () => ({ end: async () => {} }) }
  });
  await middleware({ auth: { authenticated: true, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'TENANT_CONTEXT_UNAVAILABLE' });
});
