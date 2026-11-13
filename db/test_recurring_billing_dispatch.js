'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecurringBillingDispatchStore, assertPeriod } = require('../server/recurring-billing-dispatch-store');
const { createRecurringBillingDispatcher } = require('../server/recurring-billing-dispatcher');
const { createRecurringBillingRunner } = require('../server/recurring-billing-runner');

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


test('dispatcher abandons enqueue when a lease renewal operation hangs', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      renewLease() { return new Promise(() => {}); },
      async markDispatched() { calls.push('dispatched'); return true; },
      async markFailed() { calls.push('failed'); return false; }
    },
    workerId: 'worker-a', leaseSeconds: 30, heartbeatIntervalMs: 5,
    leaseOperationTimeoutMs: 10, enqueueTimeoutMs: 1000,
    enqueueTenantJob: async () => { await gate; }
  });
  const pending = dispatcher.dispatchOne(row);
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  const result = await pending;
  assert.equal(result.state, 'lease_lost');
  assert.equal(calls.includes('dispatched'), false);
});

test('dispatcher bounds a tenant enqueue that never resolves and schedules retry', async () => {
  const failures = [];
  const dispatcher = createRecurringBillingDispatcher({
    store: {
      async listRunnable() { return [row]; },
      async claim() { return row; },
      async renewLease() { return true; },
      async markDispatched() { throw new Error('must not complete'); },
      async markFailed(input) { failures.push(input); return true; }
    },
    workerId: 'worker-a', leaseSeconds: 30, heartbeatIntervalMs: 1000,
    leaseOperationTimeoutMs: 10, enqueueTimeoutMs: 10,
    enqueueTenantJob: () => new Promise(() => {})
  });
  const result = await dispatcher.dispatchOne(row);
  assert.equal(result.state, 'retry_scheduled');
  assert.equal(result.errorCode, 'BILLING_TENANT_ENQUEUE_TIMEOUT');
  assert.equal(failures[0].errorCode, 'BILLING_TENANT_ENQUEUE_TIMEOUT');
});

test('dispatcher rejects lease operation timeouts that reach or exceed the lease', () => {
  assert.throws(() => createRecurringBillingDispatcher({
    store: { listRunnable() {}, claim() {}, markDispatched() {}, markFailed() {}, renewLease() {} },
    workerId: 'worker-a', enqueueTenantJob: async () => {},
    leaseSeconds: 30, leaseOperationTimeoutMs: 30000
  }), /RECURRING_BILLING_LEASE_OPERATION_TIMEOUT_INVALID/);
});


test('recurring billing runner bounds a tenant scan that never resolves', async () => {
  const errors = [];
  let dispatched = false;
  const runner = createRecurringBillingRunner({
    store: { enqueueActiveTenants: () => new Promise(() => {}) },
    dispatcher: { tick: async () => { dispatched = true; return {}; } },
    workerId: 'worker-a', scanOperationTimeoutMs: 10,
    now: () => new Date('2030-02-01T12:00:00Z'),
    onError: error => errors.push(error)
  });
  const result = await runner.tick();
  assert.equal(result.errorCode, 'BILLING_RUNNER_SCAN_TIMEOUT');
  assert.equal(errors[0].code, 'BILLING_RUNNER_SCAN_TIMEOUT');
  assert.equal(dispatched, false);
  await runner.stop();
});

test('recurring billing runner rejects malformed scan counters and cursors', async () => {
  const runner = createRecurringBillingRunner({
    store: { enqueueActiveTenants: async () => ({ scanned: -1, enqueued: 0, nextCursor: null }) },
    dispatcher: { tick: async () => ({}) }, workerId: 'worker-a',
    now: () => new Date('2030-02-01T12:00:00Z')
  });
  const result = await runner.tick();
  assert.equal(result.errorCode, 'BILLING_RUNNER_SCAN_RESULT_INVALID');
});


test('recurring billing runner shutdown is bounded when dispatcher never resolves', async () => {
  const errors = [];
  const runner = createRecurringBillingRunner({
    store: { enqueueActiveTenants: async () => ({ scanned: 0, enqueued: 0, nextCursor: null }) },
    dispatcher: { tick: () => new Promise(() => {}) },
    workerId: 'worker-a', stopGraceMs: 100,
    now: () => new Date('2030-02-01T12:00:00Z'),
    onError: error => errors.push(error)
  });
  const tick = runner.tick();
  await new Promise(resolve => setImmediate(resolve));
  const result = await runner.stop();
  assert.deepEqual(result, { drained: false, timedOut: true });
  assert.deepEqual(errors, [{ code: 'BILLING_RUNNER_DRAIN_TIMEOUT' }]);
  assert.deepEqual(await runner.tick(), { skipped: true });
  void tick;
});

test('recurring billing runner stop shares one shutdown promise', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = createRecurringBillingRunner({
    store: { enqueueActiveTenants: async () => ({ scanned: 0, enqueued: 0, nextCursor: null }) },
    dispatcher: { tick: async () => { await gate; return {}; } },
    workerId: 'worker-a', stopGraceMs: 1000,
    now: () => new Date('2030-02-01T12:00:00Z')
  });
  const tick = runner.tick();
  await new Promise(resolve => setImmediate(resolve));
  const a = runner.stop();
  const b = runner.stop();
  release();
  const results = await Promise.all([a, b, tick]);
  assert.deepEqual(results[0], { drained: true });
  assert.deepEqual(results[1], { drained: true });
});


test('dispatcher rejects heartbeat cadence that leaves less than two thirds of lease for recovery', () => {
  assert.throws(() => createRecurringBillingDispatcher({
    store: { listRunnable() {}, claim() {}, markDispatched() {}, markFailed() {}, renewLease() {} },
    workerId: 'worker-a', enqueueTenantJob: async () => {},
    leaseSeconds: 30, heartbeatIntervalMs: 10001
  }), /RECURRING_BILLING_HEARTBEAT_INVALID/);
});
