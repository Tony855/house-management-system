'use strict';

function withTimeout(operation, timeoutMs, code) {
  let timer;
  const pending = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function safeErrorCode(error, fallback = 'BILLING_DISPATCH_FAILED') {
  return error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
    ? error.code : fallback;
}

function createRecurringBillingDispatcher({
  store, workerId, enqueueTenantJob, leaseSeconds = 180,
  heartbeatIntervalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)),
  leaseOperationTimeoutMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 4)),
  enqueueTimeoutMs = leaseSeconds * 2000
}) {
  if (!store || !['listRunnable', 'claim', 'markDispatched', 'markFailed'].every(k => typeof store[k] === 'function')) {
    throw new TypeError('RECURRING_BILLING_STORE_INVALID');
  }
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new TypeError('RECURRING_BILLING_WORKER_INVALID');
  if (typeof enqueueTenantJob !== 'function') throw new TypeError('RECURRING_BILLING_TENANT_ENQUEUER_REQUIRED');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new TypeError('RECURRING_BILLING_LEASE_INVALID');
  if (typeof store.renewLease !== 'function') throw new TypeError('RECURRING_BILLING_LEASE_RENEWAL_REQUIRED');
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 ||
      heartbeatIntervalMs > Math.floor(leaseSeconds * 1000 / 3)) {
    throw new TypeError('RECURRING_BILLING_HEARTBEAT_INVALID');
  }
  if (!Number.isInteger(leaseOperationTimeoutMs) || leaseOperationTimeoutMs < 1 ||
      leaseOperationTimeoutMs > Math.floor(leaseSeconds * 1000 / 3)) throw new TypeError('RECURRING_BILLING_LEASE_OPERATION_TIMEOUT_INVALID');
  if (!Number.isInteger(enqueueTimeoutMs) || enqueueTimeoutMs < 1 || enqueueTimeoutMs > 3600000) {
    throw new TypeError('RECURRING_BILLING_ENQUEUE_TIMEOUT_INVALID');
  }

  async function dispatchOne(candidate) {
    let job;
    try {
      job = await withTimeout(
        () => store.claim({ id: candidate.id, workerId, leaseSeconds }),
        leaseOperationTimeoutMs, 'BILLING_DISPATCH_CLAIM_TIMEOUT'
      );
    } catch (error) {
      return Object.freeze({ id: candidate.id, state: 'claim_unavailable', errorCode: safeErrorCode(error) });
    }
    if (!job) return Object.freeze({ id: candidate.id, state: 'not_claimed' });
    let heartbeat = null, heartbeatInFlight = null, leaseLost = false;
    try {
      // A hung renewal must be treated as lease loss; never wait forever after
      // the tenant enqueue finishes and never claim ownership without renewal.
      heartbeat = setInterval(() => {
        if (heartbeatInFlight || leaseLost) return;
        heartbeatInFlight = withTimeout(
          () => store.renewLease({ id: job.id, workerId, leaseToken: job.leaseToken, leaseSeconds }),
          leaseOperationTimeoutMs, 'BILLING_DISPATCH_RENEW_TIMEOUT'
        )
          .then(renewed => { if (!renewed) leaseLost = true; })
          .catch(() => { leaseLost = true; })
          .finally(() => { heartbeatInFlight = null; });
      }, heartbeatIntervalMs);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      await withTimeout(() => enqueueTenantJob(Object.freeze({
        tenantId: job.tenantId, appId: job.appId, jobType: job.jobType,
        periodKey: job.periodKey, requestId: job.requestId
      })), enqueueTimeoutMs, 'BILLING_TENANT_ENQUEUE_TIMEOUT');
      clearInterval(heartbeat); heartbeat = null;
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) return Object.freeze({ id: job.id, state: 'lease_lost' });
      const completed = await withTimeout(
        () => store.markDispatched({ id: job.id, workerId, leaseToken: job.leaseToken }),
        leaseOperationTimeoutMs, 'BILLING_DISPATCH_COMPLETE_TIMEOUT'
      );
      return Object.freeze({ id: job.id, state: completed ? 'dispatched' : 'lease_lost' });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      let recorded = false;
      try {
        recorded = await withTimeout(() => store.markFailed({
          id: job.id, workerId, leaseToken: job.leaseToken,
          errorCode: safeErrorCode(error)
        }), leaseOperationTimeoutMs, 'BILLING_DISPATCH_FAILURE_WRITE_TIMEOUT');
      } catch (_) {}
      return Object.freeze({
        id: job.id, state: recorded ? 'retry_scheduled' : 'lease_lost',
        errorCode: safeErrorCode(error)
      });
    }
  }

  return Object.freeze({
    async tick({ limit = 20 } = {}) {
      const jobs = await withTimeout(
        () => store.listRunnable({ limit }), leaseOperationTimeoutMs, 'BILLING_DISPATCH_SCAN_TIMEOUT'
      );
      const results = [];
      for (const job of jobs) results.push(await dispatchOne(job));
      return Object.freeze({ scanned: jobs.length, results });
    },
    dispatchOne
  });
}
module.exports = { createRecurringBillingDispatcher };
