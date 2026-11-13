'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_IDS = new Set(['rental', 'hotel', 'property']);

function assertPool(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('TENANT_MIGRATION_JOB_POOL_REQUIRED');
}
function assertTenant(tenantId, appId) {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId) || !APP_IDS.has(appId)) {
    throw new TypeError('TENANT_MIGRATION_JOB_TENANT_INVALID');
  }
}
function assertWorker(workerId) {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) {
    throw new TypeError('TENANT_MIGRATION_JOB_WORKER_INVALID');
  }
}
function assertLease(seconds) {
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    throw new TypeError('TENANT_MIGRATION_JOB_LEASE_INVALID');
  }
}
function decode(row) {
  if (!row) return null;
  let checkpoint = null;
  if (row.checkpoint_json) {
    try { checkpoint = JSON.parse(row.checkpoint_json); }
    catch (_) { throw new Error('TENANT_MIGRATION_JOB_CHECKPOINT_CORRUPT'); }
  }
  return Object.freeze({
    id: Number(row.id), idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_uuid, appId: row.app_id,
    sourceOrgId: Number(row.source_org_id), mode: row.mode,
    state: row.state, attemptCount: Number(row.attempt_count),
    workerId: row.lease_owner || null, leaseToken: row.lease_token || null, leaseExpiresAt: row.lease_expires_at || null,
    checkpoint, errorCode: row.error_code || null,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}

/**
 * Durable control-plane queue for tenant data migrations.
 * Claims use a single conditional UPDATE, so two workers cannot own the same
 * live lease. Expired running jobs are reclaimable after worker loss.
 */
function createPlatformTenantMigrationJobStore(pool) {
  assertPool(pool);
  const columns = 'id, idempotency_key, tenant_uuid, app_id, source_org_id, mode, state, attempt_count, lease_owner, lease_token, lease_expires_at, checkpoint_json, error_code, created_at, updated_at';
  async function findById(id) {
    const [rows] = await pool.query('SELECT ' + columns + ' FROM platform_tenant_migration_jobs WHERE id = ? LIMIT 1', [id]);
    return decode(rows[0]);
  }
  return Object.freeze({
    async createJob({ idempotencyKey, tenantId, appId, sourceOrgId, mode = 'dry-run' }) {
      assertTenant(tenantId, appId);
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) ||
          !Number.isSafeInteger(sourceOrgId) || sourceOrgId < 1 || !['dry-run', 'copy'].includes(mode)) {
        throw new TypeError('TENANT_MIGRATION_JOB_INPUT_INVALID');
      }
      await pool.query(
        'INSERT INTO platform_tenant_migration_jobs (idempotency_key, tenant_uuid, app_id, source_org_id, mode, state) VALUES (?, ?, ?, ?, ?, \'queued\') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
        [idempotencyKey, tenantId, appId, sourceOrgId, mode]
      );
      const [rows] = await pool.query('SELECT ' + columns + ' FROM platform_tenant_migration_jobs WHERE idempotency_key = ? LIMIT 1', [idempotencyKey]);
      const job = decode(rows[0]);
      if (!job || job.tenantId !== tenantId || job.appId !== appId ||
          job.sourceOrgId !== sourceOrgId || job.mode !== mode) {
        throw Object.assign(new Error('TENANT_MIGRATION_JOB_IDEMPOTENCY_CONFLICT'), {
          code: 'TENANT_MIGRATION_JOB_IDEMPOTENCY_CONFLICT', status: 409
        });
      }
      return job;
    },
    async listRunnableJobs({ limit = 10, maxAttempts = 8 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('TENANT_MIGRATION_JOB_LIST_LIMIT_INVALID');
      }
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new TypeError('TENANT_MIGRATION_JOB_RETRY_LIMIT_INVALID');
      }
      // Reap jobs whose worker repeatedly died after claiming; no worker can
      // call failJob in that crash path, so expired leases must exhaust too.
      await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'failed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = 'TENANT_MIGRATION_ATTEMPTS_EXHAUSTED', updated_at = UTC_TIMESTAMP() WHERE state = 'running' AND lease_expires_at <= UTC_TIMESTAMP() AND attempt_count >= ?",
        [maxAttempts]
      );
      const [rows] = await pool.query(
        "SELECT " + columns + " FROM platform_tenant_migration_jobs WHERE attempt_count < ? AND (state = 'queued' OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP()))) ORDER BY created_at ASC, id ASC LIMIT ?",
        [maxAttempts, limit]
      );
      return rows.map(decode);
    },
    async getJob(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      return findById(id);
    },
    async claimJob({ id, workerId, leaseSeconds = 300, maxAttempts = 8 }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      assertWorker(workerId); assertLease(leaseSeconds);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError('TENANT_MIGRATION_JOB_RETRY_LIMIT_INVALID');
      const leaseToken = crypto.randomUUID();
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'running', lease_owner = ?, lease_token = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), attempt_count = attempt_count + 1, error_code = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND attempt_count < ? AND (state = 'queued' OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP())))",
        [workerId, leaseToken, leaseSeconds, id, maxAttempts]
      );
      if (Number(result.affectedRows) !== 1) return null;
      // Never read back by job ID alone: a later claimant may have replaced
      // this lease before the SELECT completes. Return only this exact claim.
      const [rows] = await pool.query(
        'SELECT ' + columns + ' FROM platform_tenant_migration_jobs WHERE id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP() LIMIT 1',
        [id, workerId, leaseToken]
      );
      return rows[0] ? decode(rows[0]) : null;
    },
    async renewLease({ id, workerId, leaseToken, leaseSeconds = 300 }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      assertWorker(workerId); assertLease(leaseSeconds); if (typeof leaseToken !== 'string' || !leaseToken) throw new TypeError('TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID');
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'running' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [leaseSeconds, id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    },
    async saveCheckpoint({ id, workerId, leaseToken, checkpoint }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      assertWorker(workerId); if (typeof leaseToken !== 'string' || !leaseToken) throw new TypeError('TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID');
      let json;
      try { json = JSON.stringify(checkpoint); } catch (_) { throw new TypeError('TENANT_MIGRATION_JOB_CHECKPOINT_INVALID'); }
      if (json === undefined || Buffer.byteLength(json) > 65536) throw new TypeError('TENANT_MIGRATION_JOB_CHECKPOINT_INVALID');
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET checkpoint_json = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'running' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [json, id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    },
    async completeJob({ id, workerId, leaseToken }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      assertWorker(workerId); if (typeof leaseToken !== 'string' || !leaseToken) throw new TypeError('TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID');
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'completed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'running' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    },
    async retryFailedJob({ id, expectedAttemptCount }) {
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 1) {
        throw new TypeError('TENANT_MIGRATION_JOB_RETRY_INPUT_INVALID');
      }
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'queued', attempt_count = 0, error_code = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'failed' AND attempt_count = ?",
        [id, expectedAttemptCount]
      );
      return Number(result.affectedRows) === 1;
    },
    async cancelQueuedJob({ id }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'queued'",
        [id]
      );
      return Number(result.affectedRows) === 1;
    },
    async failJob({ id, workerId, leaseToken, errorCode }) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('TENANT_MIGRATION_JOB_ID_INVALID');
      assertWorker(workerId); if (typeof leaseToken !== 'string' || !leaseToken) throw new TypeError('TENANT_MIGRATION_JOB_LEASE_TOKEN_INVALID');
      const safeCode = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(errorCode)
        ? errorCode : 'TENANT_MIGRATION_FAILED';
      const [result] = await pool.query(
        "UPDATE platform_tenant_migration_jobs SET state = 'failed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, error_code = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND state = 'running' AND lease_owner = ? AND lease_token = ? AND lease_expires_at > UTC_TIMESTAMP()",
        [safeCode, id, workerId, leaseToken]
      );
      return Number(result.affectedRows) === 1;
    }
  });
}

module.exports = { createPlatformTenantMigrationJobStore };
