'use strict';

function createRecurringBillingDispatcher({ store, workerId, enqueueTenantJob, leaseSeconds = 180 }) {
  if (!store || !['listRunnable', 'claim', 'markDispatched', 'markFailed'].every(k => typeof store[k] === 'function')) {
    throw new TypeError('RECURRING_BILLING_STORE_INVALID');
  }
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new TypeError('RECURRING_BILLING_WORKER_INVALID');
  if (typeof enqueueTenantJob !== 'function') throw new TypeError('RECURRING_BILLING_TENANT_ENQUEUER_REQUIRED');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new TypeError('RECURRING_BILLING_LEASE_INVALID');

  async function dispatchOne(candidate) {
    const job = await store.claim({ id: candidate.id, workerId, leaseSeconds });
    if (!job) return Object.freeze({ id: candidate.id, state: 'not_claimed' });
    try {
      // The adapter must resolve tenant DB credentials from the platform registry,
      // then create/get the tenant-local durable generation job idempotently.
      await enqueueTenantJob(Object.freeze({
        tenantId: job.tenantId, appId: job.appId, jobType: job.jobType,
        periodKey: job.periodKey, requestId: job.requestId
      }));
      const completed = await store.markDispatched({ id: job.id, workerId });
      return Object.freeze({ id: job.id, state: completed ? 'dispatched' : 'lease_lost' });
    } catch (error) {
      let recorded = false;
      try { recorded = await store.markFailed({
        id: job.id, workerId,
        errorCode: error && error.code
      }); } catch (_) {}
      return Object.freeze({
        id: job.id, state: recorded ? 'retry_scheduled' : 'lease_lost',
        errorCode: error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
          ? error.code : 'BILLING_DISPATCH_FAILED'
      });
    }
  }

  return Object.freeze({
    async tick({ limit = 20 } = {}) {
      const jobs = await store.listRunnable({ limit });
      const results = [];
      for (const job of jobs) results.push(await dispatchOne(job));
      return Object.freeze({ scanned: jobs.length, results });
    },
    dispatchOne
  });
}
module.exports = { createRecurringBillingDispatcher };
