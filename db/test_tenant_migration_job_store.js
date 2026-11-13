'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformTenantMigrationJobStore } = require('../server/tenant-migration-job-store');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = {
  id: 7, idempotency_key: 'migration-request-0001', tenant_uuid: tenantId,
  app_id: 'rental', source_org_id: 12, mode: 'copy', state: 'queued',
  attempt_count: 0, lease_owner: null, lease_token: null, lease_expires_at: null,
  checkpoint_json: '{"table":"rooms","lastId":42}', error_code: null,
  created_at: '2026-11-12 00:00:00', updated_at: '2026-11-12 00:00:00'
};

test('migration job creation is idempotent and rejects key reuse for another tenant payload', async () => {
  const calls = [];
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('INSERT')) return [{ insertId: 7 }, []];
    return [[row], []];
  }});
  const job = await store.createJob({ idempotencyKey: row.idempotency_key, tenantId, appId: 'rental', sourceOrgId: 12, mode: 'copy' });
  assert.equal(job.id, 7);
  assert.deepEqual(job.checkpoint, { table: 'rooms', lastId: 42 });
  await assert.rejects(store.createJob({ idempotencyKey: row.idempotency_key, tenantId, appId: 'rental', sourceOrgId: 13, mode: 'copy' }),
    error => error.code === 'TENANT_MIGRATION_JOB_IDEMPOTENCY_CONFLICT' && error.status === 409);
  assert.match(calls[0][0], /ON DUPLICATE KEY UPDATE/);
});

test('only one worker can claim a queued or expired job and attempts increment atomically', async () => {
  const calls = [];
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }, []];
    return [[{ ...row, state: 'running', lease_owner: 'worker-a', lease_token: 'lease-1', attempt_count: 1 }], []];
  }});
  const job = await store.claimJob({ id: 7, workerId: 'worker-a', leaseSeconds: 60 });
  assert.equal(job.state, 'running');
  assert.equal(job.workerId, 'worker-a');
  assert.equal(job.leaseToken, 'lease-1');
  assert.match(calls[0][0], /lease_token = \?/);
  assert.equal(job.attemptCount, 1);
  assert.match(calls[0][0], /state = 'queued'.*lease_expires_at <= UTC_TIMESTAMP\(\)/);
  assert.match(calls[0][0], /attempt_count = attempt_count \+ 1/);
});

test('active leases reject a second claimant and stale owners cannot checkpoint or complete', async () => {
  const store = createPlatformTenantMigrationJobStore({ query: async sql => {
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 0 }, []];
    throw new Error('unexpected query');
  }});
  assert.equal(await store.claimJob({ id: 7, workerId: 'worker-b' }), null);
  assert.equal(await store.saveCheckpoint({ id: 7, workerId: 'worker-b', leaseToken: 'stale-token', checkpoint: { table: 'rooms' } }), false);
  assert.equal(await store.completeJob({ id: 7, workerId: 'worker-b', leaseToken: 'stale-token' }), false);
});

test('checkpoint writes are bounded and lease-owner scoped', async () => {
  let captured;
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    captured = [sql, params]; return [{ affectedRows: 1 }, []];
  }});
  assert.equal(await store.saveCheckpoint({ id: 7, workerId: 'worker-a', leaseToken: 'lease-a', checkpoint: { table: 'rooms', lastId: 99 } }), true);
  assert.deepEqual(JSON.parse(captured[1][0]), { table: 'rooms', lastId: 99 });
  assert.match(captured[0], /lease_owner = \?/);
  await assert.rejects(store.saveCheckpoint({ id: 7, workerId: 'worker-a', leaseToken: 'lease-a', checkpoint: 'x'.repeat(70000) }), /TENANT_MIGRATION_JOB_CHECKPOINT_INVALID/);
});

test('lease renewal, completion and failure are conditional on the current unexpired owner', async () => {
  const calls = [];
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]); return [{ affectedRows: 1 }, []];
  }});
  assert.equal(await store.renewLease({ id: 7, workerId: 'worker-a', leaseToken: 'lease-a', leaseSeconds: 120 }), true);
  assert.equal(await store.completeJob({ id: 7, workerId: 'worker-a', leaseToken: 'lease-a' }), true);
  assert.equal(await store.failJob({ id: 7, workerId: 'worker-a', leaseToken: 'lease-a', errorCode: 'SOURCE_UNAVAILABLE' }), true);
  assert.match(calls[0][0], /lease_token = \?/);
  assert.match(calls[1][0], /lease_token = \?/);
  assert.match(calls[2][0], /lease_token = \?/);
  assert.match(calls[0][0], /lease_expires_at > UTC_TIMESTAMP\(\)/);
  assert.equal(calls[2][1][0], 'SOURCE_UNAVAILABLE');
});

test('migration job store rejects unsafe identifiers, leases and checkpoint payloads', async () => {
  const store = createPlatformTenantMigrationJobStore({ query: async () => [[], []] });
  await assert.rejects(store.createJob({ idempotencyKey: 'short', tenantId, appId: 'rental', sourceOrgId: 1 }), /TENANT_MIGRATION_JOB_INPUT_INVALID/);
  await assert.rejects(store.createJob({ idempotencyKey: 'migration-request-0001', tenantId, appId: 'platform', sourceOrgId: 1 }), /TENANT_MIGRATION_JOB_TENANT_INVALID/);
  await assert.rejects(store.claimJob({ id: 7, workerId: 'bad worker', leaseSeconds: 10 }), /TENANT_MIGRATION_JOB_WORKER_INVALID/);
  await assert.rejects(store.renewLease({ id: 7, workerId: 'worker-a' }), /TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID/);
  await assert.rejects(store.completeJob({ id: 7, workerId: 'worker-a' }), /TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID/);
});

test('failed jobs require an expected attempt count to retry and queued jobs can be cancelled', async () => {
  const calls = [];
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]); return [{ affectedRows: 1 }, []];
  }});
  assert.equal(await store.retryFailedJob({ id: 7, expectedAttemptCount: 2 }), true);
  assert.equal(await store.cancelQueuedJob({ id: 7 }), true);
  assert.match(calls[0][0], /state = 'failed' AND attempt_count = \?/);
  assert.match(calls[0][0], /attempt_count = 0/);
  assert.match(calls[1][0], /state = 'queued'/);
  await assert.rejects(store.retryFailedJob({ id: 7, expectedAttemptCount: 0 }), /TENANT_MIGRATION_JOB_RETRY_INPUT_INVALID/);
});


test('claim readback is bound to the exact token generated by that claim', async () => {
  const calls = [];
  let generatedToken;
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('UPDATE')) {
      generatedToken = params[1];
      return [{ affectedRows: 1 }, []];
    }
    // A competing claimant replaced the row before this worker read it back.
    return [[], []];
  }});
  const claimed = await store.claimJob({ id: 7, workerId: 'same-worker-id', leaseSeconds: 60 });
  assert.equal(claimed, null);
  assert.match(calls[1][0], /WHERE id = \? AND lease_owner = \? AND lease_token = \? AND lease_expires_at > UTC_TIMESTAMP\(\)/);
  assert.equal(calls[1][1][0], 7);
  assert.equal(calls[1][1][1], 'same-worker-id');
  assert.equal(calls[1][1][2], generatedToken);
});


test('migration store reaps crashed workers after the retry budget is exhausted', async () => {
  const calls = [];
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 3 }, []];
    return [[], []];
  }});
  assert.deepEqual(await store.listRunnableJobs({ limit: 12, maxAttempts: 4 }), []);
  assert.match(calls[0][0], /state = 'failed'.*state = 'running'.*attempt_count >= \?/);
  assert.deepEqual(calls[0][1], [4]);
  assert.match(calls[1][0], /attempt_count < \?/);
  assert.deepEqual(calls[1][1], [4, 12]);
});

test('migration store refuses claims after the retry budget is exhausted', async () => {
  let captured;
  const store = createPlatformTenantMigrationJobStore({ query: async (sql, params) => {
    captured = [sql, params];
    return [{ affectedRows: 0 }, []];
  }});
  assert.equal(await store.claimJob({ id: 7, workerId: 'worker-a', maxAttempts: 4 }), null);
  assert.match(captured[0], /WHERE id = \? AND attempt_count < \?/);
  assert.equal(captured[1][4], 4);
});
