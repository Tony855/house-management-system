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

async function safeAudit(audit, event) {
  try { await audit(event); } catch (_) { /* preserve the provisioning result; audit adapter must alert independently */ }
}

/**
 * High-privilege adapter boundary. Cleanup runs in reverse order on partial failure.
 * A failed cleanup is surfaced in the audit event; the tenant stays non-active.
 */
async function provisionTenant({
  appId, displayLabel, registry, databaseAdmin, secretStore, migrationRunner,
  isolationVerifier, audit = async () => {}, tenantId = crypto.randomUUID()
}) {
  if (!APP_IDS.has(appId) || typeof displayLabel !== 'string' || !displayLabel.trim() || !UUID_RE.test(tenantId)) {
    throw new Error('TENANT_PROVISIONING_INPUT_INVALID');
  }
  for (const [name, adapter] of Object.entries({ registry, databaseAdmin, secretStore, migrationRunner, isolationVerifier })) {
    if (!adapter) throw new TypeError(name + ' adapter is required');
  }
  const dbName = tenantDatabaseName(appId, tenantId);
  const dbUser = tenantDatabaseUser(tenantId);
  const secretRef = 'tenant-db/' + tenantId;
  const passwordBytes = crypto.randomBytes(32);
  const password = passwordBytes.toString('base64url');
  const record = {
    tenant_uuid: tenantId, app_id: appId, display_label: displayLabel.trim(),
    lifecycle_state: 'provisioning', db_host: databaseAdmin.host,
    db_port: Number(databaseAdmin.port || 3306), db_name: dbName,
    db_secret_ref: secretRef, schema_version: null
  };
  let registryCreated = false;
  let databaseCreated = false;
  let principalCreated = false;
  let secretCreated = false;

  try {
    await registry.createProvisioningTenant(record);
    registryCreated = true;
    await safeAudit(audit, { tenantId, event: 'provisioning_started' });

    await databaseAdmin.createDatabase(dbName);
    databaseCreated = true;
    await databaseAdmin.createPrincipal(dbUser, password);
    principalCreated = true;
    await databaseAdmin.grantDatabaseOnly(dbUser, dbName);
    await secretStore.put(secretRef, { user: dbUser, password });
    secretCreated = true;
    await migrationRunner.apply({ appId, tenantId, dbName, secretRef });
    const verification = await isolationVerifier.verify({ appId, tenantId, dbName, dbUser });
    if (!verification || verification.passed !== true) throw new Error('TENANT_ISOLATION_VERIFICATION_FAILED');

    await registry.activateTenant(tenantId, { schemaVersion: verification.schemaVersion || null });
    await safeAudit(audit, { tenantId, event: 'provisioning_succeeded' });
    return { tenantId, appId, lifecycleState: 'active', schemaVersion: verification.schemaVersion || null };
  } catch (error) {
    const cleanupFailures = [];
    const cleanup = async (label, operation) => {
      try { await operation(); } catch (_) { cleanupFailures.push(label); }
    };

    if (secretCreated && typeof secretStore.delete === 'function') {
      await cleanup('secret', () => secretStore.delete(secretRef));
    }
    if (principalCreated && typeof databaseAdmin.dropPrincipal === 'function') {
      await cleanup('principal', () => databaseAdmin.dropPrincipal(dbUser));
    }
    if (databaseCreated && typeof databaseAdmin.dropDatabase === 'function') {
      await cleanup('database', () => databaseAdmin.dropDatabase(dbName));
    }

    if (registryCreated) {
      try {
        await registry.markProvisioningFailed(tenantId, error.code || 'PROVISIONING_FAILED');
      } catch (_) {
        cleanupFailures.push('registry_state');
      }
    }
    await safeAudit(audit, {
      tenantId,
      event: 'provisioning_failed',
      code: error.code || 'PROVISIONING_FAILED',
      cleanupFailures
    });
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
