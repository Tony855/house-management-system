'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformTenantMigrationWorker } = require('../server/tenant-migration-worker');

const baseJob = Object.freeze({ id: 8, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appId: 'rental', sourceOrgId: 9, mode: 'copy', state: 'queued', checkpoint: { table: 'rooms', lastId: 4 } });

function fakeStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getJob() { return baseJob; },
    async claimJob(input) { calls.push(['claim', input]); return { ...baseJob, state: 'running', leaseToken: 'lease-token-1' }; },
    async renewLease(input) { calls.push(['heartbeat', input]); return true; },
    async saveCheckpoint(input) { calls.push(['checkpoint', input]); return true; },
    async completeJob(input) { calls.push(['complete', input]); return true; },
    async failJob(input) { calls.push(['fail', input]); return true; },
    ...overrides
  };
}

test('worker claims, resumes from checkpoint, heartbeats, checkpoints and completes', async () => {
  const store = fakeStore();
  const worker = createPlatformTenantMigrationWorker({
    store, workerId: 'worker-a', leaseSeconds: 90,
    executeJob: async ({ job, checkpoint, heartbeat, saveCheckpoint, leaseSeconds }) => {
      assert.equal(job.id, 8);
      assert.equal(leaseSeconds, 90);
      assert.deepEqual(checkpoint, baseJob.checkpoint);
      await heartbeat();
      await saveCheckpoint({ table: 'bills', lastId: 22 });
      return { copied: 10 };
    }
  });
  const result = await worker.runJob(8);
  assert.equal(result.state, 'completed');
  assert.deepEqual(store.calls.map(call => call[0]), ['claim', 'heartbeat', 'checkpoint', 'complete']);
  for (const call of store.calls.filter(call => ['heartbeat', 'checkpoint', 'complete'].includes(call[0]))) assert.equal(call[1].leaseToken, 'lease-token-1');
});

test('worker fails closed and records only a sanitized error code', async () => {
  const store = fakeStore();
  const worker = createPlatformTenantMigrationWorker({
    store, workerId: 'worker-a',
    executeJob: async () => { throw Object.assign(new Error('database password leaked'), { code: 'SOURCE_UNAVAILABLE' }); }
  });
  const result = await worker.runJob(8);
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'SOURCE_UNAVAILABLE');
  assert.equal(store.calls.at(-1)[0], 'fail');
  assert.equal(store.calls.at(-1)[1].errorCode, 'SOURCE_UNAVAILABLE');
});

test('worker never completes after lease loss', async () => {
  const store = fakeStore({ async renewLease() { return false; } });
  const worker = createPlatformTenantMigrationWorker({
    store, workerId: 'worker-a',
    executeJob: async ({ heartbeat }) => { await heartbeat(); }
  });
  const result = await worker.runJob(8);
  assert.equal(result.state, 'lease_lost');
  assert.equal(store.calls.some(call => call[0] === 'complete'), false);
});

test('worker does not execute missing or terminal jobs', async () => {
  const store = fakeStore({ async getJob() { return null; } });
  const worker = createPlatformTenantMigrationWorker({ store, workerId: 'worker-a', executeJob: async () => { throw new Error('must not run'); } });
  assert.equal((await worker.runJob(8)).state, 'not_found');
});

test('worker reports lease loss when a failure cannot be recorded by the expired owner', async () => {
  const store = fakeStore({ async failJob() { return false; } });
  const worker = createPlatformTenantMigrationWorker({
    store, workerId: 'worker-a',
    executeJob: async () => { throw Object.assign(new Error('operation failed'), { code: 'SOURCE_UNAVAILABLE' }); }
  });
  const result = await worker.runJob(8);
  assert.equal(result.state, 'lease_lost');
  assert.equal(store.calls.some(call => call[0] === 'complete'), false);
});


test('worker abandons migration when lease renewal hangs past its bounded timeout', async () => {
  const store = fakeStore({
    async renewLease() { return new Promise(() => {}); }
  });
  const worker = createPlatformTenantMigrationWorker({
    store, workerId: 'worker-a', leaseSeconds: 30, leaseOperationTimeoutMs: 10,
    executeJob: async ({ heartbeat }) => { await heartbeat(); }
  });
  const result = await worker.runJob(8);
  assert.equal(result.state, 'lease_lost');
  assert.equal(result.errorCode, 'TENANT_MIGRATION_JOB_LEASE_LOST');
  assert.equal(store.calls.some(call => call[0] === 'fail'), false);
  assert.equal(store.calls.some(call => call[0] === 'complete'), false);
});

test('worker rejects lease operation timeouts that could exceed the lease', () => {
  assert.throws(() => createPlatformTenantMigrationWorker({
    store: fakeStore(), workerId: 'worker-a', leaseSeconds: 30, leaseOperationTimeoutMs: 30000,
    executeJob: async () => {}
  }), /TENANT_MIGRATION_JOB_OPERATION_TIMEOUT_INVALID/);
});


test('worker bounds initial job lookup and claim operations that never resolve', async () => {
  const lookupWorker = createPlatformTenantMigrationWorker({
    store: fakeStore({ getJob: () => new Promise(() => {}) }),
    workerId: 'worker-a', leaseSeconds: 30, leaseOperationTimeoutMs: 10,
    executeJob: async () => { throw new Error('must not execute'); }
  });
  await assert.rejects(lookupWorker.runJob(8),
    error => error.code === 'TENANT_MIGRATION_JOB_LEASE_OPERATION_TIMEOUT');

  let executed = false;
  const claimWorker = createPlatformTenantMigrationWorker({
    store: fakeStore({ claimJob: () => new Promise(() => {}) }),
    workerId: 'worker-a', leaseSeconds: 30, leaseOperationTimeoutMs: 10,
    executeJob: async () => { executed = true; }
  });
  await assert.rejects(claimWorker.runJob(8),
    error => error.code === 'TENANT_MIGRATION_JOB_LEASE_OPERATION_TIMEOUT');
  assert.equal(executed, false);
});


test('worker rejects operation timeout that can outlive the lease safety margin', () => {
  assert.throws(() => createPlatformTenantMigrationWorker({
    store: fakeStore(), workerId: 'worker-a', leaseSeconds: 30,
    leaseOperationTimeoutMs: 10001, executeJob: async () => {}
  }), /TENANT_MIGRATION_JOB_OPERATION_TIMEOUT_INVALID/);
});
