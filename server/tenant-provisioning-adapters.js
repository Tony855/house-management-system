'use strict';

const mysql = require('mysql2/promise');
const { createPlatformTenantRegistry } = require('./platform-adapters');

const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;

function assertIdentifier(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) throw new TypeError(code);
  return value;
}

function createMariaDbTenantDatabaseAdmin({
  host, port = 3306, user, password, ssl, connectTimeout = 10000,
  createConnection = mysql.createConnection
}) {
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s\x00-\x1f\x7f]/.test(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof user !== 'string' || !user || typeof password !== 'string' || !password ||
      !Number.isInteger(connectTimeout) || connectTimeout < 1000 || connectTimeout > 60000 ||
      typeof createConnection !== 'function') {
    throw new TypeError('TENANT_DATABASE_ADMIN_CONFIG_INVALID');
  }
  async function execute(sql, values = []) {
    const connection = await createConnection({
      host, port, user, password, ssl,
      connectTimeout, charset: 'utf8mb4', multipleStatements: false
    });
    try { return await connection.query(sql, values); }
    finally { await connection.end(); }
  }
  return Object.freeze({
    host, port,
    async createDatabase(dbName) {
      assertIdentifier(dbName, 'TENANT_DATABASE_NAME_INVALID');
      await execute('CREATE DATABASE IF NOT EXISTS `' + dbName + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    },
    async createPrincipal(dbUser, dbPassword) {
      assertIdentifier(dbUser, 'TENANT_DATABASE_USER_INVALID');
      if (typeof dbPassword !== 'string' || dbPassword.length < 32 || dbPassword.length > 128) {
        throw new TypeError('TENANT_DATABASE_PASSWORD_INVALID');
      }
      await execute("CREATE USER IF NOT EXISTS '" + dbUser + "'@'%' IDENTIFIED BY ?", [dbPassword]);
      await execute("ALTER USER '" + dbUser + "'@'%' IDENTIFIED BY ?", [dbPassword]);
    },
    async grantDatabaseOnly(dbUser, dbName) {
      assertIdentifier(dbUser, 'TENANT_DATABASE_USER_INVALID');
      assertIdentifier(dbName, 'TENANT_DATABASE_NAME_INVALID');
      await execute("GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON `" + dbName + "`.* TO '" + dbUser + "'@'%'");
    },
    async dropPrincipal(dbUser) {
      assertIdentifier(dbUser, 'TENANT_DATABASE_USER_INVALID');
      await execute("DROP USER IF EXISTS '" + dbUser + "'@'%'");
    },
    async dropDatabase(dbName) {
      assertIdentifier(dbName, 'TENANT_DATABASE_NAME_INVALID');
      await execute('DROP DATABASE IF EXISTS `' + dbName + '`');
    }
  });
}

function createTenantProvisioningSecretStore(secretManager) {
  if (!secretManager || typeof secretManager.putSecret !== 'function' ||
      typeof secretManager.deleteSecret !== 'function') {
    throw new TypeError('TENANT_SECRET_MANAGER_WRITE_REQUIRED');
  }
  return Object.freeze({
    async put(secretRef, value) {
      if (typeof secretRef !== 'string' || !/^tenant-db\/[0-9a-f-]{36}$/i.test(secretRef) ||
          !value || typeof value.user !== 'string' || typeof value.password !== 'string') {
        throw new TypeError('TENANT_SECRET_INPUT_INVALID');
      }
      await secretManager.putSecret(secretRef, value);
    },
    async delete(secretRef) {
      if (typeof secretRef !== 'string' || !/^tenant-db\/[0-9a-f-]{36}$/i.test(secretRef)) {
        throw new TypeError('TENANT_SECRET_REFERENCE_INVALID');
      }
      await secretManager.deleteSecret(secretRef);
    }
  });
}

function createTenantProvisioningMigrationRunner(runMigrations) {
  if (typeof runMigrations !== 'function') throw new TypeError('TENANT_MIGRATION_RUNNER_REQUIRED');
  return Object.freeze({
    async apply(input) {
      if (!input || !['rental', 'hotel', 'property'].includes(input.appId) ||
          typeof input.tenantId !== 'string' || typeof input.dbName !== 'string' ||
          typeof input.secretRef !== 'string') throw new TypeError('TENANT_MIGRATION_INPUT_INVALID');
      const result = await runMigrations(input);
      if (!result || typeof result.schemaVersion !== 'string' || !result.schemaVersion) {
        throw new Error('TENANT_MIGRATION_VERSION_UNAVAILABLE');
      }
      return result;
    }
  });
}

function createTenantProvisioningIsolationVerifier(verifyIsolation) {
  if (typeof verifyIsolation !== 'function') throw new TypeError('TENANT_ISOLATION_VERIFIER_REQUIRED');
  return Object.freeze({
    async verify(input) {
      const result = await verifyIsolation(input);
      if (!result || result.passed !== true || typeof result.schemaVersion !== 'string' || !result.schemaVersion) {
        return { passed: false };
      }
      return Object.freeze({ passed: true, schemaVersion: result.schemaVersion });
    }
  });
}

function createPlatformTenantProvisioningAdapters({
  platformPool, databaseAdmin, secretManager, runMigrations, verifyIsolation
}) {
  const registry = createPlatformTenantRegistry(platformPool);
  if (!databaseAdmin || !['createDatabase', 'createPrincipal', 'grantDatabaseOnly', 'dropPrincipal', 'dropDatabase'].every(k => typeof databaseAdmin[k] === 'function') ||
      typeof databaseAdmin.host !== 'string' || !Number.isInteger(databaseAdmin.port)) {
    throw new TypeError('TENANT_DATABASE_ADMIN_REQUIRED');
  }
  return Object.freeze({
    registry: Object.freeze({
      async createProvisioningTenant(record) {
        if (!record || !['rental', 'hotel', 'property'].includes(record.app_id) ||
            typeof record.tenant_uuid !== 'string' || record.lifecycle_state !== 'provisioning') {
          throw new TypeError('TENANT_REGISTRY_RECORD_INVALID');
        }
        await platformPool.query(
          'INSERT INTO platform_tenants (tenant_uuid, app_id, display_label, lifecycle_state, db_host, db_port, db_name, db_secret_ref, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [record.tenant_uuid, record.app_id, record.display_label, record.lifecycle_state,
            record.db_host, record.db_port, record.db_name, record.db_secret_ref, record.schema_version]
        );
      },
      async activateTenant(tenantId, { schemaVersion }) {
        const [result] = await platformPool.query(
          "UPDATE platform_tenants SET lifecycle_state = 'active', schema_version = ? WHERE tenant_uuid = ? AND lifecycle_state = 'provisioning'",
          [schemaVersion, tenantId]
        );
        if (Number(result.affectedRows) !== 1) throw new Error('TENANT_REGISTRY_ACTIVATION_CONFLICT');
        await platformPool.query(
          'INSERT INTO platform_provisioning_events (tenant_uuid, event_type, outcome, detail_code) VALUES (?, ?, ?, ?)',
          [tenantId, 'tenant_activation', 'succeeded', schemaVersion]
        );
      },
      async markProvisioningFailed(tenantId, detailCode) {
        const safeCode = typeof detailCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(detailCode)
          ? detailCode : 'PROVISIONING_FAILED';
        await platformPool.query(
          "UPDATE platform_tenants SET lifecycle_state = 'provisioning_failed' WHERE tenant_uuid = ? AND lifecycle_state = 'provisioning'",
          [tenantId]
        );
        await platformPool.query(
          'INSERT INTO platform_provisioning_events (tenant_uuid, event_type, outcome, detail_code) VALUES (?, ?, ?, ?)',
          [tenantId, 'tenant_provisioning', 'failed', safeCode]
        );
      }
    }),
    databaseAdmin,
    secretStore: createTenantProvisioningSecretStore(secretManager),
    migrationRunner: createTenantProvisioningMigrationRunner(runMigrations),
    isolationVerifier: createTenantProvisioningIsolationVerifier(verifyIsolation)
  });
}

module.exports = {
  createMariaDbTenantDatabaseAdmin,
  createTenantProvisioningSecretStore,
  createTenantProvisioningMigrationRunner,
  createTenantProvisioningIsolationVerifier,
  createPlatformTenantProvisioningAdapters
};
