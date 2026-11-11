'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const http = require('node:http');
const { createPlatformBillingRouter } = require('../services/platform-api/routes');
const { createPlatformPool } = require('../server/platform-db');
const { createPlatformRepository } = require('../services/platform-api/repository');

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
function fixture({ auth, repository = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/platform', createPlatformBillingRouter({
    repository: {
      overview: async () => ({ tenants: { total: 2 } }),
      listProducts: async () => [{ product_code: 'rental' }],
      listPlans: async () => [],
      createPlan: async (input, audit) => ({ id: 10, status: 'draft', input, audit }),
      listTenants: async () => [{ tenant_uuid: 'opaque-id', app_id: 'rental', lifecycle_state: 'active' }],
      listInvoices: async () => [],
      listLedger: async () => [],
      ...repository
    },
    authenticate: (req, _res, next) => { req.platformAuth = auth; next(); }
  }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'INTERNAL_ERROR' }));
  return app;
}
const admin = { authenticated: true, audience: 'platform', appId: 'platform', adminStatus: 'active', mfaVerified: true, stepUpVerified: true, adminId: 7, permissions: ['platform:read','products:read','plans:read','plans:write','tenants:read','billing:read'] };

test('platform DB configuration is mandatory and never falls back to legacy DB settings', () => {
  assert.throws(() => createPlatformPool({ env: { DB_HOST: 'localhost', DB_NAME: 'legacy', DB_USER: 'root', DB_PASSWORD: 'x' } }), /PLATFORM_DATABASE_CONFIGURATION_REQUIRED/);
  assert.throws(() => createPlatformPool({ env: { PLATFORM_DB_HOST: 'localhost', PLATFORM_DB_NAME: 'bad-name', PLATFORM_DB_USER: 'u', PLATFORM_DB_PASSWORD: 'p' } }), /PLATFORM_DATABASE_NAME_INVALID/);
  assert.throws(() => createPlatformPool({ env: { PLATFORM_DB_HOST: 'localhost', PLATFORM_DB_NAME: 'platform_control', PLATFORM_DB_USER: 'u', PLATFORM_DB_PASSWORD: 'p', PLATFORM_DB_POOL_SIZE: '0' } }), /PLATFORM_DATABASE_POOL_SIZE_INVALID/);
  let captured;
  const pool = createPlatformPool({ env: { PLATFORM_DB_HOST: 'platform-db', PLATFORM_DB_NAME: 'platform_control', PLATFORM_DB_USER: 'platform', PLATFORM_DB_PASSWORD: 'secret' }, createPool: config => (captured = config) });
  assert.equal(pool.database, 'platform_control');
  assert.equal(captured.database, 'platform_control');
});

test('platform endpoints require platform audience, active admin, MFA and scoped permission', async () => {
  const app = fixture({ auth: { ...admin, audience: 'rental' } });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/overview');
    assert.equal(response.status, 403);
  });
  const noMfa = fixture({ auth: { ...admin, mfaVerified: false } });
  await withServer(noMfa, async base => assert.equal((await fetch(base + '/api/platform/overview')).status, 403));
  const noPermission = fixture({ auth: { ...admin, permissions: [] } });
  await withServer(noPermission, async base => assert.equal((await fetch(base + '/api/platform/overview')).status, 403));
});

test('platform tenant listing does not expose database hosts, names or secret references', async () => {
  const app = fixture({ auth: admin, repository: {
    listTenants: async () => [{ tenant_uuid: 'opaque-id', app_id: 'rental', lifecycle_state: 'active', db_host: 'private', db_name: 'private', db_secret_ref: 'secret/path' }]
  } });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/tenants');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body[0].db_host, undefined);
    assert.equal(body[0].db_name, undefined);
    assert.equal(body[0].db_secret_ref, undefined);
  });
});

test('platform plan writes require step-up and a reason and are recorded by repository', async () => {
  let created = 0;
  const app = fixture({ auth: admin, repository: { createPlan: async () => { created++; return { id: 1, status: 'draft' }; } } });
  await withServer(app, async base => {
    const payload = { productCode: 'rental', planCode: 'starter', displayName: 'Starter', interval: 'month', currency: 'USD', amountMinor: 1200 };
    const missingReason = await fetch(base + '/api/platform/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(missingReason.status, 400);
    const valid = await fetch(base + '/api/platform/plans', { method: 'POST', headers: { 'content-type': 'application/json', 'x-action-reason': 'initial plan setup' }, body: JSON.stringify(payload) });
    assert.equal(valid.status, 201);
    assert.equal(created, 1);
  });
});

test('platform plan creation commits the plan and audit in one transaction', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async sql => { calls.push(sql.startsWith('INSERT INTO platform_plans') ? 'plan' : 'audit'); return [{ insertId: 42 }, []]; },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  const repository = createPlatformRepository({ query: async () => [[], []], getConnection: async () => connection });
  const result = await repository.createPlan({
    productCode: 'rental', planCode: 'starter', displayName: 'Starter', interval: 'month',
    amountMinor: 1200, currency: 'USD', trialDays: 0, limits: {}, features: {}
  }, { adminId: 7, reason: 'approved starter plan', requestId: 'req-1' });
  assert.deepEqual(result, { id: 42, status: 'draft' });
  assert.deepEqual(calls, ['begin', 'plan', 'audit', 'commit', 'release']);
});

test('platform plan creation rolls back if audit persistence fails', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async sql => {
      if (sql.startsWith('INSERT INTO platform_billing_audit')) throw new Error('AUDIT_WRITE_FAILED');
      return [{ insertId: 43 }, []];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  const repository = createPlatformRepository({ query: async () => [[], []], getConnection: async () => connection });
  await assert.rejects(repository.createPlan({
    productCode: 'rental', planCode: 'starter', displayName: 'Starter', interval: 'month',
    amountMinor: 1200, currency: 'USD', trialDays: 0, limits: {}, features: {}
  }, { adminId: 7, reason: 'approved starter plan' }), /AUDIT_WRITE_FAILED/);
  assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});

test('platform tenant repository selects only opaque operational metadata', async () => {
  let sql = '';
  const repository = createPlatformRepository({
    query: async statement => { sql = statement; return [[{ tenant_uuid: 'opaque', app_id: 'rental' }], []]; },
    getConnection: async () => { throw new Error('unused'); }
  });
  await repository.listTenants({ appId: 'rental', limit: 10, offset: 0 });
  assert.match(sql, /tenant_uuid, app_id, display_label, lifecycle_state, schema_version/);
  assert.doesNotMatch(sql, /db_host|db_name|db_secret_ref/);
});

test('sensitive platform writes reject login-only MFA without a fresh step-up', async () => {
  const loginOnly = { ...admin, stepUpVerified: false };
  const app = fixture({ auth: loginOnly });
  await withServer(app, async base => {
    const payload = { productCode: 'rental', planCode: 'starter', displayName: 'Starter', interval: 'month', currency: 'USD', amountMinor: 1200 };
    const response = await fetch(base + '/api/platform/plans', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-action-reason': 'initial plan setup' },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'PLATFORM_STEP_UP_REQUIRED' });
  });
});
