'use strict';

const crypto = require('node:crypto');
const WORKER_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const APP_JOBS = Object.freeze({ rental: 'rental_bill', property: 'property_fee' });

function createPlatformBillingWorkerAuthorizer({ pool, workerId, workerSecret } = {}) {
  if (!pool || typeof pool.execute !== 'function') throw new TypeError('PLATFORM_BILLING_WORKER_POOL_REQUIRED');
  if (typeof workerId !== 'string' || !WORKER_RE.test(workerId)) throw new TypeError('PLATFORM_BILLING_WORKER_ID_REQUIRED');
  if (typeof workerSecret !== 'string' || Buffer.byteLength(workerSecret, 'utf8') < 32) {
    throw new TypeError('PLATFORM_BILLING_WORKER_SECRET_REQUIRED');
  }
  const secretHash = crypto.createHash('sha256').update(workerSecret, 'utf8').digest('hex');
  return async function authorizeSystem({ workerId: requestedWorkerId, appId, tenantId, jobType } = {}) {
    if (requestedWorkerId !== workerId || !Object.hasOwn(APP_JOBS, appId) ||
        APP_JOBS[appId] !== jobType || typeof tenantId !== 'string') return false;
    const [rows] = await pool.execute(
      `SELECT w.worker_id
         FROM platform_billing_workers w
         INNER JOIN platform_billing_worker_scopes s ON s.worker_id = w.worker_id
        WHERE w.worker_id = ? AND w.credential_sha256 = ? AND w.status = 'active'
          AND s.app_id = ? AND s.job_type = ?
        LIMIT 1`,
      [workerId, secretHash, appId, jobType]
    );
    return Array.isArray(rows) && rows.length === 1;
  };
}

module.exports = { createPlatformBillingWorkerAuthorizer };
