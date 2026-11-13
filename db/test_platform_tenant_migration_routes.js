'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createPlatformTenantMigrationRouter } = require('../services/platform-api/tenant-migration-routes');

const auth = Object.freeze({
  authenticated: true, audience: 'platform', appId: 'platform', adminStatus: 'active',
  adminId: 1, mfaVerified: true, stepUpVerified: true,
  permissions: ['tenants:read', 'tenants:write']
});
async function request(store, method, path, body, headers = {}, identity = auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.platformAuth = identity; next(); });
  app.use('/api/platform', createPlatformTenantMigrationRouter({ store, authenticate: (_req, _res, next) => next() }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fetch('http://127.0.0.1:' + server.address().port + path, {
      method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function fakeStore() {
  return {
    async createJob(input) { return { id: 4, ...input, state: 'queued' }; },
    async getJob(id) { return id === 4 ? { id, state: 'queued' } : null; },
    async retryFailedJob() { return true; },
    async cancelQueuedJob() { return true; }
  };
}
test('migration job creation requires platform write permission, recent MFA and an action reason', async () => {
  const store = fakeStore();
  const denied = await request(store, 'POST', '/api/platform/tenant-migrations', { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appId: 'rental', sourceOrgId: 7 }, { 'idempotency-key': 'migration-request-0001' }, { ...auth, stepUpVerified: false });
  assert.equal(denied.status, 403);
  const noReason = await request(store, 'POST', '/api/platform/tenant-migrations', { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appId: 'rental', sourceOrgId: 7 }, { 'idempotency-key': 'migration-request-0001' });
  assert.equal(noReason.status, 400);
  const ok = await request(store, 'POST', '/api/platform/tenant-migrations', { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appId: 'rental', sourceOrgId: 7, reason: 'Approved tenant migration request' }, { 'idempotency-key': 'migration-request-0001' });
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).job.state, 'queued');
});
test('migration job status is permission gated and returns no-store', async () => {
  const denied = await request(fakeStore(), 'GET', '/api/platform/tenant-migrations/4', undefined, {}, { ...auth, permissions: [] });
  assert.equal(denied.status, 403);
  const ok = await request(fakeStore(), 'GET', '/api/platform/tenant-migrations/4');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});
test('migration retry and cancel require explicit conflict-aware state transitions', async () => {
  const store = fakeStore();
  const retry = await request(store, 'POST', '/api/platform/tenant-migrations/4/retry', { expectedAttemptCount: 2, reason: 'Retry after source repair' });
  assert.equal(retry.status, 202);
  const cancel = await request(store, 'POST', '/api/platform/tenant-migrations/4/cancel', { reason: 'Operator cancelled queued migration' });
  assert.equal(cancel.status, 200);
});
