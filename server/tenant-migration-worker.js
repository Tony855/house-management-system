'use strict';

function assertStore(store) {
  const required = ['getJob', 'claimJob', 'renewLease', 'saveCheckpoint', 'completeJob', 'failJob'];
  if (!store || required.some(name => typeof store[name] !== 'function')) {
    throw new TypeError('TENANT_MIGRATION_WORKER_STORE_INVALID');
  }
}
function assertWorkerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw new TypeError('TENANT_MIGRATION_JOB_WORKER_INVALID');
  }
}
function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
    ? error.code : 'TENANT_MIGRATION_FAILED';
}

/**
 * Executes one explicitly selected durable migration job.
 * The handler must periodically call heartbeat() during long operations and
 * persist resumable progress through saveCheckpoint(). A lost lease is fatal:
 * this worker never reports completion after ownership has expired.
 */
function createPlatformTenantMigrationWorker({ store, workerId, executeJob, leaseSeconds = 300 }) {
  assertStore(store);
  assertWorkerId(workerId);
  if (typeof executeJob !== 'function') throw new TypeError('TENANT_MIGRATION_EXECUTOR_REQUIRED');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
    throw new TypeError('TENANT_MIGRATION_JOB_LEASE_INVALID');
  }

  return Object.freeze({
    async runJob(jobId) {
      const before = await store.getJob(jobId);
      if (!before) return Object.freeze({ claimed: false, state: 'not_found' });
      if (!['queued', 'running'].includes(before.state)) {
        return Object.freeze({ claimed: false, state: before.state });
      }
      const job = await store.claimJob({ id: jobId, workerId, leaseSeconds });
      if (!job) return Object.freeze({ claimed: false, state: 'not_claimed' });

      let leaseLost = false;
      const assertLease = async operation => {
        if (leaseLost) throw Object.assign(new Error('TENANT_MIGRATION_JOB_LEASE_LOST'), { code: 'TENANT_MIGRATION_JOB_LEASE_LOST' });
        const ok = await operation();
        if (ok !== true) {
          leaseLost = true;
          throw Object.assign(new Error('TENANT_MIGRATION_JOB_LEASE_LOST'), { code: 'TENANT_MIGRATION_JOB_LEASE_LOST' });
        }
      };
      const context = Object.freeze({
        job,
        checkpoint: job.checkpoint,
        heartbeat: () => assertLease(() => store.renewLease({ id: job.id, workerId, leaseSeconds })),
        saveCheckpoint: checkpoint => assertLease(() => store.saveCheckpoint({ id: job.id, workerId, checkpoint }))
      });

      try {
        const result = await executeJob(context);
        await assertLease(() => store.completeJob({ id: job.id, workerId }));
        return Object.freeze({ claimed: true, state: 'completed', jobId: job.id, result });
      } catch (error) {
        let failureRecorded = false;
        if (!leaseLost) {
          try { failureRecorded = await store.failJob({ id: job.id, workerId, errorCode: safeErrorCode(error) }); }
          catch (_) { /* lease expiry/recovery remains the source of truth */ }
        }
        return Object.freeze({
          claimed: true,
          state: leaseLost || failureRecorded !== true ? 'lease_lost' : 'failed',
          jobId: job.id,
          errorCode: safeErrorCode(error)
        });
      }
    }
  });
}

module.exports = { createPlatformTenantMigrationWorker };
