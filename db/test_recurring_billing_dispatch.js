'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecurringBillingDispatchStore, assertPeriod } = require('../server/recurring-billing-dispatch-store');
const { createRecurringBillingDispatcher } = require('../server/recurring-billing-dispatcher');

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = { id: 5, tenant_uuid: tenant, app_id: 'property', job_type: 'property_fee', period_key: '2030-02', request_id: 'auto-property_fee-' + tenant + '-2030-02', state: 'dispatching', attempt_count: 1, lease_owner: 'worker-a', lease_expires_at: '2030-02-01 00:03:00', error_code: null };

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
      async markDispatched(input) { calls.push(['dispatched', input]); return true; },
      async markFailed(input) { calls.push(['failed', input]); return true; }
    },
    workerId: 'worker-a',
    enqueueTenantJob: async input => { calls.push(['enqueue', input]); }
  });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'dispatched');
  assert.deepEqual(calls.map(x => x[0]), ['claim', 'enqueue', 'dispatched']);
  assert.deepEqual(calls[1][1], {
    tenantId: tenant, appId: 'property', jobType: 'property_fee',
    periodKey: '2030-02', requestId: row.request_id
  });
});

test('dispatcher retries failures without exposing raw exception messages', async () => {
  const calls = [];
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async markDispatched() { return false; },
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
      async markDispatched() { return false; },
      async markFailed() { return false; }
    },
    workerId: 'worker-a', enqueueTenantJob: async () => {}
  });
  assert.equal((await dispatcher.tick()).results[0].state, 'lease_lost');
});
