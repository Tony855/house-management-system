'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantSystemWriteService } = require('../server/tenant-system-write-service');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup(overrides = {}) {
  const calls = [];
  const repository = { withTransaction: async fn => {
    calls.push('BEGIN');
    try { const result = await fn({ calls }); calls.push('COMMIT'); return result; }
    catch (error) { calls.push('ROLLBACK'); throw error; }
  } };
  const service = createTenantSystemWriteService({
    authorizeSystem: async input => { calls.push(['authorize', input.workerId, input.appId, input.tenantId, input.jobType]); return true; },
    auditWriter: { appendSystem: async (tx, event) => { tx.calls.push(['audit', event.event, event.workerId]); } },
    idempotencyStore: { execute: async (_tx, input, mutate) => {
      calls.push(['idempotency', input.userId, input.requestId]);
      return { status: 'executed', result: await mutate() };
    } },
    ...overrides
  });
  return { service, repository, calls };
}
const request = {
  workerId: 'billing-worker-01', appId: 'rental', tenantId,
  tenantContext: { appId: 'rental', tenantId }, jobType: 'rental_bill',
  requestId: 'auto-rental-bill-aaaaaaaa-2026-11-12',
  payload: { job_id: 42, __resource: 'rental-bill-generation-job-process' },
  mutate: async tx => { tx.calls.push('MUTATE'); return { state: 'running' }; }
};

test('system write uses explicit machine actor and a separately authorized policy', async () => {
  const f = setup();
  assert.deepEqual(await f.service.execute({ ...request, repository: f.repository }), { state: 'running' });
  assert.deepEqual(f.calls, [
    ['authorize', request.workerId, request.appId, tenantId, request.jobType],
    'BEGIN',
    ['audit', 'tenant_system_write_started', request.workerId],
    ['idempotency', 'system:' + request.workerId, request.requestId],
    'MUTATE',
    ['audit', 'tenant_system_write_committed', request.workerId],
    'COMMIT'
  ]);
});

test('system write rejects app/job mismatches and tenant context substitution', async () => {
  const f = setup();
  await assert.rejects(f.service.execute({ ...request, repository: f.repository, jobType: 'property_fee' }), /TENANT_SYSTEM_WRITE_CONTEXT_INVALID/);
  await assert.rejects(f.service.execute({ ...request, repository: f.repository, tenantContext: { appId: 'rental', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }), /TENANT_SYSTEM_WRITE_CONTEXT_INVALID/);
  assert.equal(f.calls.length, 0);
});

test('system write cannot execute when deployment policy denies the machine actor', async () => {
  const f = setup({ authorizeSystem: async () => false });
  await assert.rejects(f.service.execute({ ...request, repository: f.repository }), /TENANT_SYSTEM_WRITE_FORBIDDEN/);
  assert.deepEqual(f.calls, []);
});

test('system write rolls back domain mutation when audit persistence fails', async () => {
  const f = setup({ auditWriter: { appendSystem: async (tx, event) => {
    tx.calls.push(['audit', event.event]);
    if (event.event === 'tenant_system_write_committed') throw new Error('AUDIT_STORAGE_UNAVAILABLE');
  } } });
  await assert.rejects(f.service.execute({ ...request, repository: f.repository }), /AUDIT_STORAGE_UNAVAILABLE/);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.ok(!f.calls.includes('COMMIT'));
});

test('system write requires explicit authorization, system audit and idempotency adapters', () => {
  assert.throws(() => createTenantSystemWriteService({}), /TENANT_SYSTEM_WRITE_AUTHORIZER_REQUIRED/);
  assert.throws(() => createTenantSystemWriteService({ authorizeSystem: async () => true }), /TENANT_SYSTEM_WRITE_AUDIT_REQUIRED/);
  assert.throws(() => createTenantSystemWriteService({ authorizeSystem: async () => true, auditWriter: { appendSystem: async () => {} } }), /TENANT_SYSTEM_WRITE_IDEMPOTENCY_REQUIRED/);
});
