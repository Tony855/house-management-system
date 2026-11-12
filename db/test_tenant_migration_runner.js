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
