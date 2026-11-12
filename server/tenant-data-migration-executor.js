'use strict';

const { copyTenantOrgData } = require('./tenant-data-migration');
const { createMariaDbTenantMigrationAdapters } = require('./tenant-data-migration-mariadb');

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

    let heartbeatRunning = false;
    let heartbeatFailure = null;
    const beat = async () => {
      if (heartbeatRunning || heartbeatFailure) return;
      heartbeatRunning = true;
      try { await heartbeat(); } catch (error) { heartbeatFailure = error; }
      finally { heartbeatRunning = false; }
    };
    const timer = setInterval(() => { void beat(); }, heartbeatIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    let connections;
    try {
      await heartbeat();
      await saveCheckpoint({ phase: 'resolving_connections', updatedAt: new Date().toISOString() });
      connections = await resolveConnections(Object.freeze({
        appId: job.appId, tenantId: job.tenantId, sourceOrgId: job.sourceOrgId
      }));
      if (!connections || !connections.sourcePool || !connections.targetPool ||
          typeof connections.audit !== 'function') throw new TypeError('TENANT_MIGRATION_CONNECTIONS_INVALID');

      const adapters = createMariaDbTenantMigrationAdapters({
        appId: job.appId, sourcePool: connections.sourcePool, targetPool: connections.targetPool
      });
      await saveCheckpoint({ phase: 'copy_started', updatedAt: new Date().toISOString() });
      const result = await copyTenantOrgData({
        appId: job.appId, tenantId: job.tenantId, sourceOrgId: job.sourceOrgId,
        mode: job.mode, ...adapters, audit: connections.audit
      });
      if (heartbeatFailure) throw heartbeatFailure;
      await heartbeat();
      await saveCheckpoint({
        phase: 'verified', manifest: result.manifest,
        copied: result.copied, alreadyImported: result.alreadyImported === true,
        cutover: false, updatedAt: new Date().toISOString()
      });
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
