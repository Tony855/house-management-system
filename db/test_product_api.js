'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
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
      const pool = { database: context.db.database, execute: async () => [[], {}] };
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

test('product route receives only the pool resolved from verified tenant identity', async () => {
  const { app } = setup({
    routes: () => {
      const router = express.Router();
      router.get('/tenant-data', (req, res) => res.json({ database: req.tenantDb.config?.database || req.tenantDb.database }));
      return router;
    },
    poolManager: { getPool: async context => ({ database: context.db.database, execute: async () => [[], {}] }) }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/tenant-data', { headers: { 'x-tenant-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { database: 'rental_a' });
  });
});

test('product API sanitizes malformed middleware errors and never emits invalid HTTP status codes', async () => {
  const { app } = setup({
    registry: { findTenantById: async () => { throw Object.assign(new Error('secret db host password'), { status: 200, code: 'db-secret-password' }); } }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/tenant-context');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'TENANT_CONTEXT_UNAVAILABLE' });
  });
});

test('product API does not expose arbitrary error messages to clients', async () => {
  const { app } = setup({
    routes: () => {
      const router = express.Router();
      router.get('/failure', (_req, _res, next) => next(Object.assign(new Error('internal db credentials'), { status: 400 })));
      return router;
    }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/failure');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'REQUEST_FAILED' });
  });
});

test('product API injects repository bound to the resolved tenant pool', async () => {
  const calls = [];
  const tenantPool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{ id: 1, room_no: '101' }]];
    }
  };
  const { app } = setup({
    routes: () => {
      const router = express.Router();
      router.get('/rooms', async (req, res, next) => {
        try {
          const rows = await req.tenantRepository.list('rooms', { columns: ['id', 'room_no'], filters: { status: 'vacant' } });
          res.json(rows);
        } catch (error) { next(error); }
      });
      return router;
    },
    poolManager: { getPool: async () => tenantPool }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/rooms');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 1, room_no: '101' }]);
    assert.match(calls[0].sql, /FROM `rooms` WHERE `status` = \? ORDER BY `id` ASC LIMIT \? OFFSET \?/);
    assert.deepEqual(calls[0].params, ['vacant', 50, 0]);
  });
});


test('product API binds optional tenant write capability to verified request context', async () => {
  const calls = [];
  const writeService = { execute: async input => {
    calls.push(input);
    return { saved: true };
  } };
  const { app } = setup({
    authenticate: (req, _res, next) => {
      req.auth = {
        authenticated: true, appId: 'rental', tenantId,
        userId: 'user-1', sessionId: 'session-identifier-1234'
      };
      next();
    },
    writeService,
    routes: () => {
      const router = express.Router();
      router.post('/write-check', async (req, res, next) => {
        try {
          const result = await req.tenantWrite({ operation: 'update', reason: 'Correct room rent after review' });
          res.json(result);
        } catch (error) { next(error); }
      });
      return router;
    }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/write-check', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth.tenantId, tenantId);
    assert.equal(calls[0].tenantContext.tenantId, tenantId);
    assert.equal(calls[0].repository !== undefined, true);
  });
});

test('product API rejects malformed optional tenant write service at construction', () => {
  assert.throws(() => setup({ writeService: {} }), /PRODUCT_TENANT_WRITE_SERVICE_INVALID/);
});

test('product API exposes tenant-local login before bearer authentication and protects logout', async () => {
  const calls = [];
  const { app } = setup({
    loginService: {
      login: async input => { calls.push(['login', input]); return { accessToken: 'signed-token', tokenType: 'Bearer' }; },
      logout: async auth => { calls.push(['logout', auth]); return { ok: true }; }
    },
    authenticate: (req, _res, next) => {
      req.auth = { authenticated: true, appId: 'rental', tenantId, userId: 'u-1', sessionId: 'session-identifier-1234' };
      next();
    }
  });
  await withServer(app, async base => {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'tenant.example.test' },
      body: JSON.stringify({ username: 'same-user', password: 'correct', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { accessToken: 'signed-token', tokenType: 'Bearer' });
    assert.deepEqual(calls[0], ['login', { host: '127.0.0.1', username: 'same-user', password: 'correct' }]);
    const logout = await fetch(base + '/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
    assert.equal(calls[1][1].tenantId, tenantId);
  });
});

test('product API does not expose login/logout routes when login service is not configured', async () => {
  const { app } = setup();
  await withServer(app, async base => {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(login.status, 503);
    const logout = await fetch(base + '/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 503);
  });
});
