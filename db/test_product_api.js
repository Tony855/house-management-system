'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createProductApi } = require('../server/product-api');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant = {
  tenant_uuid: tenantId, app_id: 'rental', lifecycle_state: 'active',
  db_host: 'db.internal', db_port: 3306, db_name: 'rental_a',
  db_secret_ref: 'secret/rental-a', schema_version: 'v1'
};

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

function setup(overrides = {}) {
  const pools = [];
  const options = {
    appId: 'rental',
    authenticate: (req, _res, next) => {
      req.auth = { authenticated: true, appId: 'rental', tenantId };
      next();
    },
    registry: { findTenantById: async id => id === tenantId ? tenant : null },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'rental_a', password: 'secret' }) },
    poolManager: { getPool: async context => {
      const pool = { database: context.db.database };
      pools.push(pool);
      return pool;
    } },
    ...overrides
  };
  return { app: createProductApi(options), pools };
}

test('product API only exposes health before authentication and resolves tenant from verified auth', async () => {
  const { app, pools } = setup();
  await withServer(app, async base => {
    const health = await fetch(base + '/health/live');
    assert.equal(health.status, 200);
    const context = await fetch(base + '/api/tenant-context?tenantId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      headers: { 'x-tenant-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    });
    assert.equal(context.status, 200);
    assert.deepEqual(await context.json(), { appId: 'rental', tenantId, schemaVersion: 'v1' });
    assert.equal(pools.length, 1);
    assert.equal(pools[0].database, 'rental_a');
  });
});

test('product API rejects cross-app tokens before tenant DB pool access', async () => {
  let poolCalls = 0;
  const { app } = setup({
    authenticate: (req, _res, next) => {
      req.auth = { authenticated: true, appId: 'hotel', tenantId };
      next();
    },
    poolManager: { getPool: async () => { poolCalls++; return {}; } }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/tenant-context');
    assert.equal(response.status, 403);
    assert.equal(poolCalls, 0);
  });
});

test('product API fails closed when authenticator is missing or tenant is inactive', async () => {
  assert.throws(() => setup({ authenticate: null }), /PRODUCT_AUTHENTICATOR_REQUIRED/);
  const { app } = setup({ registry: { findTenantById: async () => ({ ...tenant, lifecycle_state: 'suspended' }) } });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/tenant-context');
    assert.equal(response.status, 423);
  });
});

test('product API rejects tenant identifiers supplied only by request input', async () => {
  const { app } = setup({
    authenticate: (req, _res, next) => {
      req.auth = { authenticated: true, appId: 'rental' };
      next();
    }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/tenant-context?tenantId=' + tenantId);
    assert.equal(response.status, 403);
  });
});
