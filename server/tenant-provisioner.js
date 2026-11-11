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

/**
 * High-privilege adapter boundary. This module never embeds DB admin credentials.
 * Implementations of databaseAdmin/secretStore must be provided by the platform
 * deployment using a secret manager and a restricted provisioning identity.
 */
async function provisionTenant({
  appId, displayLabel, registry, databaseAdmin, secretStore, migrationRunner,
  isolationVerifier, audit = async () => {}, tenantId = crypto.randomUUID()
}) {
  if (!APP_IDS.has(appId) || typeof displayLabel !== 'string' || !displayLabel.trim()) {
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

  await registry.createProvisioningTenant(record);
  await audit({ tenantId, event: 'provisioning_started' });
  try {
    await databaseAdmin.createDatabase(dbName);
    await databaseAdmin.createPrincipal(dbUser, password);
    await databaseAdmin.grantDatabaseOnly(dbUser, dbName);
    await secretStore.put(secretRef, { user: dbUser, password });
    await migrationRunner.apply({ appId, tenantId, dbName, secretRef });
    const verification = await isolationVerifier.verify({ appId, tenantId, dbName, dbUser });
    if (!verification || verification.passed !== true) throw new Error('TENANT_ISOLATION_VERIFICATION_FAILED');
    await registry.activateTenant(tenantId, { schemaVersion: verification.schemaVersion || null });
    await audit({ tenantId, event: 'provisioning_succeeded' });
    return { tenantId, appId, lifecycleState: 'active', schemaVersion: verification.schemaVersion || null };
  } catch (error) {
    await registry.markProvisioningFailed(tenantId, error.code || 'PROVISIONING_FAILED');
    await audit({ tenantId, event: 'provisioning_failed', code: error.code || 'PROVISIONING_FAILED' });
    throw error;
  } finally {
    passwordBytes.fill(0);
  }
}

module.exports = { tenantDatabaseName, tenantDatabaseUser, provisionTenant };
