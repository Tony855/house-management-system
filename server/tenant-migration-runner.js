'use strict';

function createPlatformTenantMigrationRunner({
  store, worker, concurrency = 2, pollIntervalMs = 5000, onError = () => {}
} = {}) {
  if (!store || typeof store.listRunnableJobs !== 'function') {
    throw new TypeError('TENANT_MIGRATION_RUNNER_STORE_INVALID');
  }
  if (!worker || typeof worker.runJob !== 'function') {
    throw new TypeError('TENANT_MIGRATION_RUNNER_WORKER_INVALID');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 300000) {
    throw new TypeError('TENANT_MIGRATION_RUNNER_CONFIG_INVALID');
  }
  if (typeof onError !== 'function') throw new TypeError('TENANT_MIGRATION_RUNNER_ERROR_HANDLER_INVALID');

  const active = new Map();
  let timer = null;
  let ticking = false;
  let stopping = false;

  function report(error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
      ? error.code : 'TENANT_MIGRATION_RUNNER_FAILED';
    try { onError(Object.freeze({ code })); } catch (_) {}
  }

  async function tick() {
    if (stopping || ticking) return 0;
    const capacity = concurrency - active.size;
    if (capacity <= 0) return 0;
    ticking = true;
    try {
      const jobs = await store.listRunnableJobs({ limit: Math.min(50, capacity) });
      if (!Array.isArray(jobs)) throw new TypeError('TENANT_MIGRATION_RUNNER_JOB_LIST_INVALID');
      let launched = 0;
      for (const job of jobs) {
        if (stopping || active.size >= concurrency) break;
        if (!job || !Number.isSafeInteger(job.id) || job.id < 1 || active.has(job.id)) continue;
        const promise = Promise.resolve().then(() => worker.runJob(job.id))
          .catch(error => { report(error); })
          .finally(() => { active.delete(job.id); });
        active.set(job.id, promise);
        launched += 1;
      }
      return launched;
    } catch (error) {
      report(error);
      return 0;
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (stopping) throw new Error('TENANT_MIGRATION_RUNNER_STOPPED');
    if (timer) return false;
    timer = setInterval(() => { void tick(); }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void tick();
    return true;
  }

  async function waitForIdle() {
    while (ticking || active.size) {
      const pending = [...active.values()];
      if (pending.length) await Promise.allSettled(pending);
      else await Promise.resolve();
    }
  }

  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    await waitForIdle();
  }

  return Object.freeze({
    tick, start, stop, waitForIdle,
    isRunning: () => Boolean(timer) && !stopping,
    getActiveCount: () => active.size
  });
}

module.exports = { createPlatformTenantMigrationRunner };
