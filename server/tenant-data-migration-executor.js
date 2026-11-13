'use strict';

const { copyTenantOrgData } = require('./tenant-data-migration');
const { createMariaDbTenantMigrationAdapters } = require('./tenant-data-migration-mariadb');

function assertNotAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('TENANT_MIGRATION_JOB_LEASE_LOST'), {
    code: 'TENANT_MIGRATION_JOB_LEASE_LOST'
  });
}

/**
 * Builds the production migration executor around an explicit credential/
 * connection resolver. The resolver must return a read-only legacy source pool,
 * a tenant-scoped target pool, and a durable audit function. No credentials are
 * accepted from the job payload or exposed in checkpoints/results.
 */
function createTenantDataMigrationExecutor({ resolveConnections, heartbeatIntervalMs = 60000 } = {}) {
  if (typeof resolveConnections !== 'function') throw new TypeError('TENANT_MIGRATION_CONNECTION_RESOLVER_REQUIRED');
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 5000 || heartbeatIntervalMs > 120000) {
    throw new TypeError('TENANT_MIGRATION_HEARTBEAT_INTERVAL_INVALID');
  }

  return async function executeTenantMigration({ job, heartbeat, saveCheckpoint }) {
    if (!job || !Number.isSafeInteger(job.id) || !['rental', 'hotel', 'property'].includes(job.appId) ||
        !['dry-run', 'copy'].includes(job.mode)) throw new TypeError('TENANT_MIGRATION_JOB_INVALID');
    if (typeof heartbeat !== 'function' || typeof saveCheckpoint !== 'function') {
      throw new TypeError('TENANT_MIGRATION_WORKER_CONTEXT_INVALID');
    }

    let heartbeatPromise = null;
    let heartbeatFailure = null;
    const abortController = new AbortController();
    const beat = () => {
      if (heartbeatFailure) return Promise.resolve();
      if (heartbeatPromise) return heartbeatPromise;
      heartbeatPromise = Promise.resolve().then(() => heartbeat()).catch(error => {
        heartbeatFailure = error;
        abortController.abort(error);
      }).finally(() => { heartbeatPromise = null; });
      return heartbeatPromise;
    };
    const timer = setInterval(() => { void beat(); }, heartbeatIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    let connections;
    try {
      await beat();
      if (heartbeatFailure) throw heartbeatFailure;
      assertNotAborted(abortController.signal);
      await saveCheckpoint({ phase: 'resolving_connections', updatedAt: new Date().toISOString() });
      assertNotAborted(abortController.signal);
      connections = await resolveConnections(Object.freeze({
        appId: job.appId, tenantId: job.tenantId, sourceOrgId: job.sourceOrgId,
        signal: abortController.signal
      }));
      assertNotAborted(abortController.signal);
      if (!connections || !connections.sourcePool || !connections.targetPool ||
          typeof connections.audit !== 'function') throw new TypeError('TENANT_MIGRATION_CONNECTIONS_INVALID');

      const adapters = createMariaDbTenantMigrationAdapters({
        appId: job.appId, sourcePool: connections.sourcePool, targetPool: connections.targetPool
      });
      await saveCheckpoint({ phase: 'copy_started', updatedAt: new Date().toISOString() });
      assertNotAborted(abortController.signal);
      const result = await copyTenantOrgData({
        appId: job.appId, tenantId: job.tenantId, sourceOrgId: job.sourceOrgId,
        mode: job.mode, ...adapters, audit: connections.audit, signal: abortController.signal
      });
      await beat();
      if (heartbeatFailure) throw heartbeatFailure;
      assertNotAborted(abortController.signal);
      await saveCheckpoint({
        phase: 'verified', manifest: result.manifest,
        copied: result.copied, alreadyImported: result.alreadyImported === true,
        cutover: false, updatedAt: new Date().toISOString()
      });
      assertNotAborted(abortController.signal);
      return Object.freeze({
        mode: result.mode, appId: result.appId, tenantId: result.tenantId,
        sourceOrgId: result.sourceOrgId, manifest: result.manifest,
        copied: result.copied, cutover: false
      });
    } finally {
      clearInterval(timer);
      if (connections?.close) await connections.close();
    }
  };
}

module.exports = { createTenantDataMigrationExecutor };
