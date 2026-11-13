'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = Object.freeze({ rental: 'rental_bill', property: 'property_fee' });
function assertPool(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('RECURRING_BILLING_POOL_REQUIRED');
}
function assertPeriod(appId, periodKey) {
  let valid = false;
  if (appId === 'rental' && /^\d{4}-\d{2}-\d{2}$/.test(periodKey || '')) {
    const [year, month, day] = periodKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  } else if (appId === 'property') {
    valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey || '');
  }
  if (!valid) throw new TypeError('RECURRING_BILLING_PERIOD_INVALID');
}
function assertLeaseToken(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError('RECURRING_BILLING_LEASE_TOKEN_INVALID');
}
function assertWorker(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) throw new TypeError('RECURRING_BILLING_WORKER_INVALID');
}
function decode(row) {
  return Object.freeze({
    id: Number(row.id), tenantId: row.tenant_uuid, appId: row.app_id,
    jobType: row.job_type, periodKey: row.period_key, requestId: row.request_id,
    state: row.state, attemptCount: Number(row.attempt_count),
    workerId: row.lease_owner || null, leaseToken: row.lease_token || null, leaseExpiresAt: row.lease_expires_at || null,
    errorCode: row.error_code || null
  });
}
function createRecurringBillingDispatchStore(pool) {
  assertPool(pool);
  const columns = 'id, tenant_uuid, app_id, job_type, period_key, request_id, state, attempt_count, lease_owner, lease_token, lease_expires_at, error_code';
  return Object.freeze({
    async enqueueActiveTenants({ appId, periodKey, afterTenantId = '', limit = 100 }) {
      assertPeriod(appId, periodKey);
      if (typeof afterTenantId !== 'string' || (afterTenantId && !UUID_RE.test(afterTenantId)) ||
          !Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('RECURRING_BILLING_SCAN_INVALID');
      const [tenants] = await pool.query(
        'SELECT tenant_uuid, app_id FROM platform_tenants WHERE lifecycle_state = ? AND app_id = ? AND tenant_uuid > ? ORDER BY tenant_uuid ASC LIMIT ?',
        ['active', appId, afterTenantId, limit]
      );
      let enqueued = 0;
      for (const tenant of tenants) {
        if (!UUID_RE.test(tenant.tenant_uuid || '') || tenant.app_id !== appId) continue;
        const jobType = TYPES[appId];
        const requestId = 'auto-' + jobType + '-' + tenant.tenant_uuid + '-' + periodKey;
        const [result] = await pool.query(
          'INSERT IGNORE INTO platform_recurring_billing_dispatch (tenant_uuid, app_id, job_type, period_key, request_id, state) VALUES (?, ?, ?, ?, ?, \'queued\')',
          [tenant.tenant_uuid, appId, jobType, periodKey, requestId]
        );
        enqueued += Number(result.affectedRows) === 1 ? 1 : 0;
      }
      return Object.freeze({
        scanned: tenants.length, enqueued,
        nextCursor: tenants.length === limit ? tenants[tenants.length - 1].tenant_uuid : null
      });
    },
    async listRunnable({ limit = 20, maxAttempts = 8 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('RECURRING_BILLING_LIST_LIMIT_INVALID');
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError('RECURRING_BILLING_RETRY_LIMIT_INVALID');
      // A worker crash cannot call markFailed; reap expired leases that have
      // already consumed the retry budget so they do not remain dispatching forever.
      await pool.query(
        "UPDATE platform_recurring_billing_dispatch SET state = 'failed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = 'BILLING_DISPATCH_ATTEMPTS_EXHAUSTED' WHERE state = 'dispatching' AND lease_expires_at <= UTC_TIMESTAMP() AND attempt_count >= ?",
        [maxAttempts]
      );
      const [rows] = await pool.query(
        "SELECT " + columns + " FROM platform_recurring_billing_dispatch WHERE attempt_count < ? AND ((state = 'queued' AND available_at <= UTC_TIMESTAMP()) OR (state = 'dispatching' AND lease_expires_at <= UTC_TIMESTAMP())) ORDER BY available_at,id LIMIT ?",
        [maxAttempts, limit]
      );
      return rows.map(decode);
    },
    async claim({ id, workerId, leaseSeconds = 180, maxAttempts = 8 }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('RECURRING_BILLING_JOB_ID_INVALID');
      assertWorker(workerId);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new TypeError('RECURRING_BILLING_LEASE_INVALID');
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError('RECURRING_BILLING_RETRY_LIMIT_INVALID');
      const leaseToken = crypto.randomUUID();
      const [result] = await pool.query(
        "UPDATE platform_recurring_billing_dispatch SET state = 'dispatching', lease_owner = ?, lease_token = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), attempt_count = attempt_count + 1, error_code = NULL WHERE id = ? AND attempt_count < ? AND ((state = 'queued' AND available_at <= UTC_TIMESTAMP()) OR (state = 'dispatching' AND lease_expires_at <= UTC_TIMESTAMP()))",
        [workerId, leaseToken, leaseSeconds, id, maxAttempts]
      );
      if (Number(result.affectedRows) !== 1) return null;
      const [rows] = await pool.query(
        'SELECT ' + columns + ' FROM platform_recurring_billing_dispatch WHERE id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP() LIMIT 1',
        [id, workerId, leaseToken]
      );
      return rows[0] ? decode(rows[0]) : null;
    },
    async renewLease({ id, workerId, leaseToken, leaseSeconds = 180 }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('RECURRING_BILLING_JOB_ID_INVALID');
      assertWorker(workerId);
      assertLeaseToken(leaseToken);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 1800) throw new TypeError('RECURRING_BILLING_LEASE_INVALID');
      const [result] = await pool.query(
        "UPDATE platform_recurring_billing_dispatch SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [leaseSeconds, id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    },
    async markDispatched({ id, workerId, leaseToken }) {
      assertWorker(workerId);
      assertLeaseToken(leaseToken);
      const [result] = await pool.query(
        "UPDATE platform_recurring_billing_dispatch SET state = 'dispatched', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = NULL WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    },
    async markFailed({ id, workerId, leaseToken, errorCode, maxAttempts = 8 }) {
      assertWorker(workerId);
      assertLeaseToken(leaseToken);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError('RECURRING_BILLING_RETRY_LIMIT_INVALID');
      const code = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(errorCode) ? errorCode : 'BILLING_DISPATCH_FAILED';
      const [result] = await pool.query(
        "UPDATE platform_recurring_billing_dispatch SET state = IF(attempt_count >= ?, 'failed', 'queued'), available_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL LEAST(3600, POW(2, LEAST(attempt_count, 11))) SECOND), lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = ? WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [maxAttempts, code, id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    }
  });
}
module.exports = { createRecurringBillingDispatchStore, assertPeriod };
