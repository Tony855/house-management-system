'use strict';

const crypto = require('crypto');
const { APP_IDS } = require('./tenant-registry');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantDatabaseName(appId, tenantId) {
  if (!APP_IDS.has(appId) || !UUID_RE.test(tenantId)) throw new Error('TENANT_PROVISIONING_INPUT_INVALID');
  return appId + '_' + tenantId.replace(/-/g, '').slice(0, 24);
}

function tenantDatabaseUser(tenantId) {
  if (!UUID_RE.test(tenantId)) throw new Error('TENANT_PROVISIONING_INPUT_INVALID');
  return 't_' + tenantId.replace(/-/g, '').slice(0, 24);
}

async function writeAudit(audit, event) {
  if (typeof audit !== 'function') throw new TypeError('TENANT_AUDIT_ADAPTER_REQUIRED');
  await audit(event);
}

/**
 * High-privilege adapter boundary. Cleanup runs in reverse order on partial failure.
 * A failed cleanup is surfaced in the audit event; the tenant stays non-active.
 */
async function provisionTenant({
  appId, displayLabel, registry, databaseAdmin, secretStore, migrationRunner,
  isolationVerifier, audit, tenantId = crypto.randomUUID()
}) {
  if (!APP_IDS.has(appId) || typeof displayLabel !== 'string' || !displayLabel.trim() ||
      displayLabel.length > 120 || /[\x00-\x1f\x7f]/.test(displayLabel) || !UUID_RE.test(tenantId)) {
    throw new Error('TENANT_PROVISIONING_INPUT_INVALID');
  }
  if (typeof audit !== 'function') throw new TypeError('TENANT_AUDIT_ADAPTER_REQUIRED');
  const requiredMethods = {
    registry: ['createProvisioningTenant', 'activateTenant', 'markProvisioningFailed'],
    databaseAdmin: ['createDatabase', 'createPrincipal', 'grantDatabaseOnly'],
    secretStore: ['put'],
    migrationRunner: ['apply'],
    isolationVerifier: ['verify']
  };
  for (const [name, methods] of Object.entries(requiredMethods)) {
    const adapter = ({ registry, databaseAdmin, secretStore, migrationRunner, isolationVerifier })[name];
    if (!adapter || methods.some(method => typeof adapter[method] !== 'function')) {
      throw new TypeError('TENANT_PROVISIONING_ADAPTER_INVALID');
    }
  }
  const dbHost = databaseAdmin.host;
  const dbPort = databaseAdmin.port === undefined ? 3306 : databaseAdmin.port;
  if (typeof dbHost !== 'string' || !dbHost || dbHost.length > 253 || /[\s\x00-\x1f\x7f]/.test(dbHost) ||
      !Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
    throw new Error('TENANT_DATABASE_ENDPOINT_INVALID');
  }
  const dbName = tenantDatabaseName(appId, tenantId);
  const dbUser = tenantDatabaseUser(tenantId);
  const secretRef = 'tenant-db/' + tenantId;
  const passwordBytes = crypto.randomBytes(32);
  const password = passwordBytes.toString('base64url');
  const record = {
    tenant_uuid: tenantId, app_id: appId, display_label: displayLabel.trim(),
    lifecycle_state: 'provisioning', db_host: databaseAdmin.host,
    db_port: dbPort, db_name: dbName,
    db_secret_ref: secretRef, schema_version: null
  };
  let registryAttempted = false;
  let databaseAttempted = false;
  let principalAttempted = false;
  let secretAttempted = false;

  try {
    registryAttempted = true;
    await registry.createProvisioningTenant(record);
    await writeAudit(audit, { tenantId, event: 'provisioning_started' });

    databaseAttempted = true;
    await databaseAdmin.createDatabase(dbName);
    principalAttempted = true;
    await databaseAdmin.createPrincipal(dbUser, password);
    await databaseAdmin.grantDatabaseOnly(dbUser, dbName);
    secretAttempted = true;
    await secretStore.put(secretRef, { user: dbUser, password });
    await migrationRunner.apply({ appId, tenantId, dbName, secretRef });
    const verification = await isolationVerifier.verify({ appId, tenantId, dbName, dbUser });
    if (!verification || verification.passed !== true) throw new Error('TENANT_ISOLATION_VERIFICATION_FAILED');

    // Persist the successful verification before the irreversible activation.
    // If audit storage is unavailable, the tenant remains non-active.
    await writeAudit(audit, { tenantId, event: 'provisioning_verified', schemaVersion: verification.schemaVersion || null });
    await registry.activateTenant(tenantId, { schemaVersion: verification.schemaVersion || null });
    return { tenantId, appId, lifecycleState: 'active', schemaVersion: verification.schemaVersion || null };
  } catch (error) {
    const cleanupFailures = [];
    const cleanup = async (label, operation) => {
      try { await operation(); } catch (_) { cleanupFailures.push(label); }
    };

    // Calls may succeed remotely and then time out locally. Reconcile by the
    // deterministic tenant resource names, not by success flags set after await.
    if (secretAttempted) {
      if (typeof secretStore.delete === 'function') await cleanup('secret', () => secretStore.delete(secretRef));
      else cleanupFailures.push('secret_cleanup_unavailable');
    }
    if (principalAttempted) {
      if (typeof databaseAdmin.dropPrincipal === 'function') await cleanup('principal', () => databaseAdmin.dropPrincipal(dbUser));
      else cleanupFailures.push('principal_cleanup_unavailable');
    }
    if (databaseAttempted) {
      if (typeof databaseAdmin.dropDatabase === 'function') await cleanup('database', () => databaseAdmin.dropDatabase(dbName));
      else cleanupFailures.push('database_cleanup_unavailable');
    }

    if (registryAttempted) {
      try {
        await registry.markProvisioningFailed(tenantId, error.code || 'PROVISIONING_FAILED');
      } catch (_) {
        cleanupFailures.push('registry_state');
      }
    }
    try {
      await writeAudit(audit, {
        tenantId,
        event: 'provisioning_failed',
        code: error.code || 'PROVISIONING_FAILED',
        cleanupFailures
      });
    } catch (auditError) {
      error.auditFailure = auditError.code || auditError.message || 'AUDIT_WRITE_FAILED';
      cleanupFailures.push('audit');
    }
    if (cleanupFailures.length) {
      error.cleanupFailures = cleanupFailures;
      error.code = error.code || 'PROVISIONING_FAILED_CLEANUP_INCOMPLETE';
    }
    throw error;
  } finally {
    passwordBytes.fill(0);
  }
}

module.exports = { tenantDatabaseName, tenantDatabaseUser, provisionTenant };
