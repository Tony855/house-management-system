'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantWriteService, fingerprintPayload } = require('../server/tenant-write-service');

const auth = Object.freeze({
  authenticated: true, appId: 'rental',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'user-1', sessionId: 'session-identifier-1234'
});
const tenantContext = Object.freeze({ appId: 'rental', tenantId: auth.tenantId, schemaVersion: '1' });
const request = Object.freeze({
  auth, tenantContext, operation: 'update', reason: 'Correct room rent after review',
  stepUpToken: 'step-up-token-1234567890', requestId: 'request-identifier-0001',
  payload: { amount: 100, note: 'approved' },
  mutate: async tx => { tx.calls.push('MUTATE'); return { updated: true }; }
});

function setup(overrides = {}) {
  const calls = [];
  const repository = {
    async withTransaction(fn) {
      const tx = { calls };
      calls.push('BEGIN');
      try {
        const result = await fn(tx);
        calls.push('COMMIT');
        return result;
      } catch (error) {
        calls.push('ROLLBACK');
        throw error;
      }
    }
  };
  const service = createTenantWriteService({
    authorize: async input => { calls.push(['authorize', input.auth.tenantId]); return true; },
    verifyStepUp: async input => { calls.push(['step-up', input.reason]); return true; },
    auditWriter: { append: async (tx, event) => { tx.calls.push(['audit', event.event]); } },
    idempotencyStore: { execute: async (_tx, input, mutate) => {
      calls.push(['idempotency', input.requestId]);
      return { status: 'executed', result: await mutate() };
    } },
    ...overrides
  });
  return { service, repository, calls };
}

test('tenant write requires valid authenticated tenant and product context', async () => {
  const { service, repository } = setup();
  await assert.rejects(service.execute({ ...request, repository, tenantContext: { ...tenantContext, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }), /TENANT_WRITE_CONTEXT_INVALID/);
  await assert.rejects(service.execute({ ...request, repository, auth: { ...auth, appId: 'hotel' } }), /TENANT_WRITE_CONTEXT_INVALID/);
});

test('tenant write requires a reason, step-up token, request id and valid payload', async () => {
  const { service, repository } = setup();
  await assert.rejects(service.execute({ ...request, repository, reason: 'no' }), /TENANT_WRITE_REQUEST_INVALID/);
  await assert.rejects(service.execute({ ...request, repository, stepUpToken: '' }), /TENANT_WRITE_REQUEST_INVALID/);
  await assert.rejects(service.execute({ ...request, repository, requestId: 'short' }), /TENANT_WRITE_REQUEST_INVALID/);
  await assert.rejects(service.execute({ ...request, repository, payload: null }), /TENANT_WRITE_PAYLOAD_INVALID/);
});

test('tenant write authorizes and step-up verifies before opening a transaction', async () => {
  const denied = setup({ authorize: async () => false });
  await assert.rejects(denied.service.execute({ ...request, repository: denied.repository }), /TENANT_WRITE_FORBIDDEN/);
  assert.deepEqual(denied.calls, []);
  const noStepUp = setup({ verifyStepUp: async () => false });
  await assert.rejects(noStepUp.service.execute({ ...request, repository: noStepUp.repository }), /TENANT_WRITE_STEP_UP_INVALID/);
  assert.equal(noStepUp.calls.some(call => call === 'BEGIN'), false);
});

test('tenant write appends start and commit audit events in the same transaction', async () => {
  const { service, repository, calls } = setup();
  const result = await service.execute({ ...request, repository });
  assert.deepEqual(result, { updated: true });
  assert.deepEqual(calls, [
    ['authorize', auth.tenantId], ['step-up', request.reason], 'BEGIN',
    ['audit', 'tenant_write_started'], ['idempotency', request.requestId], 'MUTATE',
    ['audit', 'tenant_write_committed'], 'COMMIT'
  ]);
});

test('tenant write rolls back business mutation if audit append fails', async () => {
  const f = setup({ auditWriter: { append: async (tx, event) => {
    tx.calls.push(['audit', event.event]);
    if (event.event === 'tenant_write_committed') throw new Error('AUDIT_STORAGE_UNAVAILABLE');
  } } });
  await assert.rejects(f.service.execute({ ...request, repository: f.repository }), /AUDIT_STORAGE_UNAVAILABLE/);
  assert.equal(f.calls.includes('ROLLBACK'), true);
  assert.equal(f.calls.includes('COMMIT'), false);
});

test('tenant write rolls back when domain mutation fails', async () => {
  const f = setup();
  await assert.rejects(f.service.execute({
    ...request, repository: f.repository,
    mutate: async () => { throw new Error('DOMAIN_VALIDATION_FAILED'); }
  }), /DOMAIN_VALIDATION_FAILED/);
  assert.equal(f.calls.includes('ROLLBACK'), true);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[1] === 'tenant_write_committed'), false);
});

test('tenant write requires authorization, step-up and audit adapters at construction', () => {
  assert.throws(() => createTenantWriteService({}), /TENANT_WRITE_AUTHORIZER_REQUIRED/);
  assert.throws(() => createTenantWriteService({ authorize: async () => true }), /TENANT_WRITE_STEP_UP_REQUIRED/);
  assert.throws(() => createTenantWriteService({ authorize: async () => true, verifyStepUp: async () => true }), /TENANT_WRITE_AUDIT_REQUIRED/);
  assert.throws(() => createTenantWriteService({ authorize: async () => true, verifyStepUp: async () => true, auditWriter: { append: async () => {} } }), /TENANT_WRITE_IDEMPOTENCY_REQUIRED/);
});

test('tenant write replays an identical idempotency key without repeating the mutation', async () => {
  let stored;
  let mutationCount = 0;
  const f = setup({
    idempotencyStore: {
      async execute(_tx, input, mutate) {
        if (stored) {
          if (stored.fingerprint !== input.requestFingerprint) return { status: 'conflict' };
          return { status: 'replayed', result: stored.result };
        }
        const result = await mutate();
        stored = { fingerprint: input.requestFingerprint, result };
        return { status: 'executed', result };
      }
    }
  });
  const mutate = async tx => { mutationCount++; tx.calls.push('MUTATE'); return { recordId: 42 }; };
  const first = await f.service.execute({ ...request, repository: f.repository, mutate });
  const second = await f.service.execute({ ...request, repository: f.repository, mutate });
  assert.deepEqual(first, { recordId: 42 });
  assert.deepEqual(second, { recordId: 42 });
  assert.equal(mutationCount, 1);
  assert.ok(f.calls.some(call => Array.isArray(call) && call[1] === 'tenant_write_replayed'));
});

test('tenant write rejects reuse of an idempotency key with a different payload fingerprint', async () => {
  let fingerprint;
  const f = setup({
    idempotencyStore: {
      execute: async (_tx, input) => {
        if (!fingerprint) { fingerprint = input.requestFingerprint; return { status: 'executed', result: { updated: true } }; }
        return input.requestFingerprint === fingerprint
          ? { status: 'replayed', result: { updated: true } }
          : { status: 'conflict' };
      }
    }
  });
  await f.service.execute({ ...request, repository: f.repository });
  await assert.rejects(
    f.service.execute({ ...request, repository: f.repository, payload: { amount: 200, note: 'approved' } }),
    error => error.code === 'TENANT_WRITE_IDEMPOTENCY_CONFLICT' && error.status === 409
  );
});


test('server-defined resource scope separates otherwise identical idempotency payloads', () => {
  const shared = { name: 'Tower A', remark: '' };
  const building = fingerprintPayload({ ...shared, __resource: 'buildings' });
  const tenant = fingerprintPayload({ ...shared, __resource: 'tenants' });
  assert.notEqual(building, tenant);
  assert.equal(building, fingerprintPayload({ ...shared, __resource: 'buildings' }));
});
