'use strict';

function localDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: values.year + '-' + values.month + '-' + values.day, month: values.year + '-' + values.month };
}

function createRecurringBillingRunner({
  store, dispatcher, workerId, timeZone = 'Asia/Phnom_Penh',
  pollIntervalMs = 60000, scanBatchSize = 100, dispatchBatchSize = 20,
  now = () => new Date(), onError = () => {}
} = {}) {
  if (!store || typeof store.enqueueActiveTenants !== 'function') throw new TypeError('BILLING_RUNNER_STORE_REQUIRED');
  if (!dispatcher || typeof dispatcher.tick !== 'function') throw new TypeError('BILLING_RUNNER_DISPATCHER_REQUIRED');
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new TypeError('BILLING_RUNNER_WORKER_INVALID');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 3600000 ||
      !Number.isInteger(scanBatchSize) || scanBatchSize < 1 || scanBatchSize > 500 ||
      !Number.isInteger(dispatchBatchSize) || dispatchBatchSize < 1 || dispatchBatchSize > 100) {
    throw new TypeError('BILLING_RUNNER_CONFIG_INVALID');
  }
  if (typeof onError !== 'function' || typeof now !== 'function') throw new TypeError('BILLING_RUNNER_CALLBACK_INVALID');
  // Validate the timezone at construction, not after the worker has started.
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  let timer = null, stopping = false, ticking = false;
  function report(error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
      ? error.code : 'BILLING_RUNNER_FAILED';
    try { onError(Object.freeze({ code })); } catch (_) {}
  }
  async function scan(appId, periodKey) {
    let cursor = '';
    let totalScanned = 0, totalEnqueued = 0;
    for (;;) {
      const result = await store.enqueueActiveTenants({ appId, periodKey, afterTenantId: cursor, limit: scanBatchSize });
      totalScanned += result.scanned;
      totalEnqueued += result.enqueued;
      if (!result.nextCursor) break;
      if (result.nextCursor === cursor) throw Object.assign(new Error('BILLING_TENANT_SCAN_CURSOR_STALLED'), { code: 'BILLING_TENANT_SCAN_CURSOR_STALLED' });
      cursor = result.nextCursor;
    }
    return { appId, periodKey, scanned: totalScanned, enqueued: totalEnqueued };
  }
  async function tick() {
    if (stopping || ticking) return Object.freeze({ skipped: true });
    ticking = true;
    try {
      const { date, month } = localDateParts(now(), timeZone);
      const scans = await Promise.all([
        scan('rental', date),
        scan('property', month)
      ]);
      const dispatched = await dispatcher.tick({ limit: dispatchBatchSize });
      return Object.freeze({ scans, dispatched });
    } catch (error) {
      report(error);
      return Object.freeze({ errorCode: typeof error?.code === 'string' ? error.code : 'BILLING_RUNNER_FAILED' });
    } finally { ticking = false; }
  }
  function start() {
    if (stopping) throw new Error('BILLING_RUNNER_STOPPED');
    if (timer) return false;
    timer = setInterval(() => { void tick(); }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void tick();
    return true;
  }
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (ticking) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return Object.freeze({ tick, start, stop, isRunning: () => Boolean(timer) && !stopping });
}
module.exports = { createRecurringBillingRunner, localDateParts };
