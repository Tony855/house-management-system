'use strict';

function createRecurringBillingDispatcher({ store, workerId, enqueueTenantJob, leaseSeconds = 180, heartbeatIntervalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)) }) {
  if (!store || !['listRunnable', 'claim', 'markDispatched', 'markFailed'].every(k => typeof store[k] === 'function')) {
    throw new TypeError('RECURRING_BILLING_STORE_INVALID');
  }
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new TypeError('RECURRING_BILLING_WORKER_INVALID');
  if (typeof enqueueTenantJob !== 'function') throw new TypeError('RECURRING_BILLING_TENANT_ENQUEUER_REQUIRED');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new TypeError('RECURRING_BILLING_LEASE_INVALID');
  if (!store || typeof store.renewLease !== 'function') throw new TypeError('RECURRING_BILLING_LEASE_RENEWAL_REQUIRED');
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= leaseSeconds * 1000) throw new TypeError('RECURRING_BILLING_HEARTBEAT_INVALID');

  async function dispatchOne(candidate) {
    const job = await store.claim({ id: candidate.id, workerId, leaseSeconds });
    if (!job) return Object.freeze({ id: candidate.id, state: 'not_claimed' });
    let heartbeat = null, heartbeatInFlight = null, leaseLost = false;
    try {
      // Renew the platform claim while cross-database tenant enqueue is in flight.
      heartbeat = setInterval(() => {
        if (heartbeatInFlight || leaseLost) return;
        heartbeatInFlight = Promise.resolve().then(() => store.renewLease({ id: job.id, workerId, leaseToken: job.leaseToken, leaseSeconds }))
          .then(renewed => { if (!renewed) leaseLost = true; })
          .catch(() => { leaseLost = true; })
          .finally(() => { heartbeatInFlight = null; });
      }, heartbeatIntervalMs);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      await enqueueTenantJob(Object.freeze({
        tenantId: job.tenantId, appId: job.appId, jobType: job.jobType,
        periodKey: job.periodKey, requestId: job.requestId
      }));
      clearInterval(heartbeat); heartbeat = null;
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) return Object.freeze({ id: job.id, state: 'lease_lost' });
      const completed = await store.markDispatched({ id: job.id, workerId, leaseToken: job.leaseToken });
      return Object.freeze({ id: job.id, state: completed ? 'dispatched' : 'lease_lost' });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      let recorded = false;
      try { recorded = await store.markFailed({
        id: job.id, workerId, leaseToken: job.leaseToken,
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
