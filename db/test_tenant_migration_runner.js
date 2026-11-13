'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformTenantMigrationRunner } = require('../server/tenant-migration-runner');

test('runner dispatches bounded runnable jobs and does not overlap ticks', async () => {
  const dispatched = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = createPlatformTenantMigrationRunner({
    store: { async listRunnableJobs({ limit }) {
      assert.equal(limit, 2);
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    } },
    worker: { async runJob(id) { dispatched.push(id); await gate; return { state: 'completed' }; } },
    concurrency: 2
  });
  assert.equal(await runner.tick(), 2);
  assert.equal(await runner.tick(), 0);
  assert.deepEqual(dispatched.sort(), [1, 2]);
  release();
  await runner.waitForIdle();
});

test('runner does not dispatch duplicate jobs while an execution is active', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const runner = createPlatformTenantMigrationRunner({
    store: { async listRunnableJobs() { return [{ id: 9 }, { id: 9 }]; } },
    worker: { async runJob() { calls += 1; await gate; return { state: 'completed' }; } },
    concurrency: 3
  });
  assert.equal(await runner.tick(), 1);
  assert.equal(await runner.tick(), 0);
  assert.equal(calls, 1);
  release();
  await runner.waitForIdle();
});

test('runner validates configuration and stops polling before draining active jobs', async () => {
  assert.throws(() => createPlatformTenantMigrationRunner({
    store: {}, worker: { runJob() {} }
  }), /TENANT_MIGRATION_RUNNER_STORE_INVALID/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = createPlatformTenantMigrationRunner({
    store: { async listRunnableJobs() { return [{ id: 10 }]; } },
    worker: { async runJob() { await gate; return { state: 'completed' }; } },
    concurrency: 1, pollIntervalMs: 1000
  });
  await runner.tick();
  const stopping = runner.stop();
  release();
  await stopping;
  assert.equal(runner.isRunning(), false);
});

test('runner stop waits for an in-flight poll without starving its I/O completion', async () => {
  let releaseList;
  const listGate = new Promise(resolve => { releaseList = resolve; });
  const runner = createPlatformTenantMigrationRunner({
    store: { async listRunnableJobs() { await listGate; return []; } },
    worker: { async runJob() { throw new Error('no jobs should be dispatched'); } },
    concurrency: 1
  });
  const polling = runner.tick();
  const stopping = runner.stop();
  releaseList();
  await Promise.all([polling, stopping]);
  assert.equal(runner.getActiveCount(), 0);
  assert.equal(runner.isRunning(), false);
});


test('runner shutdown is bounded when a migration job never resolves', async () => {
  const errors = [];
  const runner = createPlatformTenantMigrationRunner({
    store: { async listRunnableJobs() { return [{ id: 77 }]; } },
    worker: { runJob: () => new Promise(() => {}) },
    concurrency: 1, stopGraceMs: 100, onError: error => errors.push(error)
  });
  await runner.tick();
  const result = await runner.stop();
  assert.deepEqual(result, { drained: false, timedOut: true, active: 1 });
  assert.deepEqual(errors, [{ code: 'TENANT_MIGRATION_RUNNER_DRAIN_TIMEOUT' }]);
  assert.equal(runner.isRunning(), false);
});

test('runner validates shutdown drain deadline', () => {
  assert.throws(() => createPlatformTenantMigrationRunner({
    store: { listRunnableJobs() {} }, worker: { runJob() {} }, stopGraceMs: 0
  }), /TENANT_MIGRATION_RUNNER_CONFIG_INVALID/);
});
