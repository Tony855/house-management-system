'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecurringBillingDispatchStore, assertPeriod } = require('../server/recurring-billing-dispatch-store');
const { createRecurringBillingDispatcher } = require('../server/recurring-billing-dispatcher');

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = { id: 5, tenantId: tenant, appId: 'property', jobType: 'property_fee', periodKey: '2030-02', requestId: 'auto-property_fee-' + tenant + '-2030-02', state: 'dispatching', attemptCount: 1, workerId: 'worker-a', leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', leaseExpiresAt: '2030-02-01 00:03:00', errorCode: null };

test('billing dispatch period validation is product-specific and strict', () => {
  assertPeriod('rental', '2030-02-01');
  assertPeriod('property', '2030-02');
  assert.throws(() => assertPeriod('rental', '2030-13-01'), /RECURRING_BILLING_PERIOD_INVALID/);
  assert.throws(() => assertPeriod('hotel', '2030-02'), /RECURRING_BILLING_PERIOD_INVALID/);
});

test('active tenant scan is bounded, app-scoped and idempotently enqueues only newly inserted jobs', async () => {
  const calls = [];
  const store = createRecurringBillingDispatchStore({ query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT tenant_uuid')) return [[{ tenant_uuid: tenant, app_id: 'property' }], []];
    return [{ affectedRows: 1 }, []];
  }});
  const result = await store.enqueueActiveTenants({ appId: 'property', periodKey: '2030-02', limit: 100 });
  assert.deepEqual(result, { scanned: 1, enqueued: 1, nextCursor: null });
  assert.match(calls[0][0], /lifecycle_state = \?/);
  assert.deepEqual(calls[0][1], ['active', 'property', '', 100]);
  assert.match(calls[1][0], /INSERT IGNORE/);
  assert.equal(calls[1][1][0], tenant);
  assert.equal(calls[1][1][2], 'property_fee');
});

test('dispatcher uses tenant-local idempotent adapter and marks success only after enqueue', async () => {
  const calls = [];
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim(input) { calls.push(['claim', input]); return row; },
      async renewLease() { return true; },
      async markDispatched(input) { calls.push(['dispatched', input]); return true; },
      async renewLease() { return true; },
      async markFailed(input) { calls.push(['failed', input]); return true; }
    },
    workerId: 'worker-a',
    enqueueTenantJob: async input => { calls.push(['enqueue', input]); }
  });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'dispatched');
  assert.deepEqual(calls.map(x => x[0]), ['claim', 'enqueue', 'dispatched']);
  assert.equal(calls[2][1].leaseToken, row.leaseToken, 'completion must be fenced by the exact claim token');
  assert.deepEqual(calls[1][1], {
    tenantId: tenant, appId: 'property', jobType: 'property_fee',
    periodKey: '2030-02', requestId: row.requestId
  });
});

test('dispatcher retries failures without exposing raw exception messages', async () => {
  const calls = [];
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async renewLease() { return true; },
      async markDispatched() { return false; },
      async renewLease() { return true; },
      async markFailed(input) { calls.push(input); return true; }
    },
    workerId: 'worker-a',
    enqueueTenantJob: async () => { throw Object.assign(new Error('database password'), { code: 'TENANT_DB_UNAVAILABLE' }); }
  });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'retry_scheduled');
  assert.equal(result.results[0].errorCode, 'TENANT_DB_UNAVAILABLE');
  assert.equal(calls[0].errorCode, 'TENANT_DB_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('database password'), false);
});

test('dispatcher reports lease loss rather than completing after ownership expires', async () => {
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async renewLease() { return true; },
      async markDispatched() { return false; },
      async markFailed() { return false; }
    },
    workerId: 'worker-a', enqueueTenantJob: async () => {}
  });
  assert.equal((await dispatcher.tick()).results[0].state, 'lease_lost');
});


test('dispatcher renews a lease during a slow tenant enqueue and only completes after heartbeat', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async renewLease(input) { calls.push(['renew', input]); return true; },
      async markDispatched(input) { calls.push(['dispatched', input]); return true; },
      async markFailed(input) { calls.push(['failed', input]); return true; }
    },
    workerId: 'worker-a', leaseSeconds: 30, heartbeatIntervalMs: 5,
    enqueueTenantJob: async () => { await gate; }
  });
  const pending = dispatcher.tick();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(calls.some(call => call[0] === 'renew'));
  release();
  const result = await pending;
  assert.equal(result.results[0].state, 'dispatched');
  assert.equal(calls.at(-1)[0], 'dispatched');
});

test('dispatcher never marks a job dispatched after heartbeat reports lease loss', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async renewLease() { return false; },
      async markDispatched() { calls.push('dispatched'); return true; },
      async markFailed() { calls.push('failed'); return false; }
    },
    workerId: 'worker-a', leaseSeconds: 30, heartbeatIntervalMs: 5,
    enqueueTenantJob: async () => { await gate; }
  });
  const pending = dispatcher.tick();
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  const result = await pending;
  assert.equal(result.results[0].state, 'lease_lost');
  assert.equal(calls.includes('dispatched'), false);
});
