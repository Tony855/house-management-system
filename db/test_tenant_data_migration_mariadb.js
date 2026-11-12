'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { TABLES } = require('../server/tenant-repository');
const { copyTenantOrgData } = require('../server/tenant-data-migration');
const { createMariaDbTenantMigrationAdapters } = require('../server/tenant-data-migration-mariadb');
const { tenantDatabaseName } = require('../server/tenant-provisioner');

const APPS = ['rental', 'hotel', 'property'];

async function createTenantDatabase(adminPool, config, sourceDatabase, appId, tenantId, createdDatabases, targetPools) {
  const database = tenantDatabaseName(appId, tenantId);
  await adminPool.execute('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  createdDatabases.push(database);
  const pool = mysql.createPool({ ...config, database });
  targetPools.push(pool);
  const tables = [...TABLES[appId]].sort();
  const placeholders = tables.map(() => '?').join(', ');
  const [sourceOrgColumns] = await adminPool.execute(
    'SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = \'org_id\' AND TABLE_NAME IN (' + placeholders + ')',
    [sourceDatabase, ...tables]
  );
  if (Number(sourceOrgColumns[0]?.total) !== tables.length) throw new Error('TENANT_MIGRATION_SOURCE_SCHEMA_SCOPE_INVALID_' + appId);
  for (const table of tables) {
    await adminPool.execute(
      'CREATE TABLE `' + database + '`.`' + table + '` LIKE `' + sourceDatabase + '`.`' + table + '`'
    );
    await adminPool.execute('ALTER TABLE `' + database + '`.`' + table + '` DROP COLUMN `org_id`');
  }
  const [targetOrgColumns] = await adminPool.execute(
    'SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = \'org_id\' AND TABLE_NAME IN (' + placeholders + ')',
    [database, ...tables]
  );
  if (Number(targetOrgColumns[0]?.total) !== 0) throw new Error('TENANT_MIGRATION_TARGET_SCHEMA_ORG_ID_PRESENT_' + appId);
  return { database, pool };
}

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('TENANT_MIGRATION_MARIADB_TEST_ONLY');
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 8,
    multipleStatements: false
  };
  const adminPool = mysql.createPool(config);
  const createdDatabases = [];
  const sourcePools = [];
  const targetPools = [];
  const fixtures = [];

  try {
    for (const appId of APPS) {
      const sourceDatabase = 'house_sys_' + appId;
      const sourcePool = mysql.createPool({ ...config, database: sourceDatabase });
      sourcePools.push(sourcePool);
      const suffix = crypto.randomBytes(5).toString('hex');
      const sourceOrgId = crypto.randomInt(100000000, 200000000);
      const decoyOrgId = crypto.randomInt(200000001, 300000000);
      const tenantId = crypto.randomUUID();
      const tenantId2 = crypto.randomUUID();

      const selectedName = 'migration-' + appId + '-' + suffix;
      const decoyName = 'decoy-' + appId + '-' + suffix;
      await sourcePool.execute(
        'INSERT INTO `buildings` (`org_id`, `name`, `address`, `remark`) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        [sourceOrgId, selectedName, 'CI fixture', 'selected org',
         decoyOrgId, decoyName, 'Other org', 'must not migrate']
      );
      const [[selectedRows], [decoyRows]] = await Promise.all([
        sourcePool.execute('SELECT `id` FROM `buildings` WHERE `org_id` = ? AND `name` = ?', [sourceOrgId, selectedName]),
        sourcePool.execute('SELECT `id` FROM `buildings` WHERE `org_id` = ? AND `name` = ?', [decoyOrgId, decoyName])
      ]);
      if (selectedRows.length !== 1 || decoyRows.length !== 1) throw new Error('TENANT_MIGRATION_FIXTURE_INSERT_FAILED_' + appId);
      const firstId = selectedRows[0].id;
      const secondId = decoyRows[0].id;
      fixtures.push({ sourcePool, firstId, sourceOrgId }, { sourcePool, firstId: secondId, sourceOrgId: decoyOrgId });

      const target = await createTenantDatabase(adminPool, config, sourceDatabase, appId, tenantId, createdDatabases, targetPools);
      const target2 = await createTenantDatabase(adminPool, config, sourceDatabase, appId, tenantId2, createdDatabases, targetPools);

      const adapters = createMariaDbTenantMigrationAdapters({ appId, sourcePool, targetPool: target.pool });
      const result = await copyTenantOrgData({
        appId, tenantId, sourceOrgId, mode: 'copy', ...adapters,
        audit: async event => {
          if (event.event === 'tenant_data_migration_copy_failed') throw new Error('UNEXPECTED_MIGRATION_FAILURE');
        }
      });
      if (!result.copied || result.cutover || result.manifest.buildings.rowCount !== 1) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_RESULT_INVALID_' + appId);
      }

      const adapters2 = createMariaDbTenantMigrationAdapters({ appId, sourcePool, targetPool: target2.pool });
      let loseAuditAcknowledgement = true;
      let firstRetryError;
      try {
        await copyTenantOrgData({
          appId, tenantId: tenantId2, sourceOrgId, mode: 'copy', ...adapters2,
          audit: async event => {
            if (event.event === 'tenant_data_migration_copy_verified' && loseAuditAcknowledgement) {
              loseAuditAcknowledgement = false;
              throw new Error('SIMULATED_MARIADB_AUDIT_ACK_LOSS');
            }
          }
        });
      } catch (error) {
        firstRetryError = error;
      }
      if (firstRetryError?.message !== 'SIMULATED_MARIADB_AUDIT_ACK_LOSS') {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_AUDIT_LOSS_FIXTURE_FAILED_' + appId);
      }
      const retryResult = await copyTenantOrgData({
        appId, tenantId: tenantId2, sourceOrgId, mode: 'copy', ...adapters2,
        audit: async () => {}
      });
      if (!retryResult.alreadyImported || !retryResult.copied) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_RETRY_NOT_RECONCILED_' + appId);
      }
      const [rows1] = await target.pool.execute('SELECT `id`, `name` FROM `buildings` WHERE `id` = ?', [firstId]);
      const [rows2] = await target2.pool.execute('SELECT `id`, `name` FROM `buildings` WHERE `id` = ?', [firstId]);
      if (rows1.length !== 1 || rows2.length !== 1 || rows1[0].name !== rows2[0].name) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_READBACK_FAILED_' + appId);
      }
      await target2.pool.execute('UPDATE `buildings` SET `name` = ? WHERE `id` = ?', ['tenant-two-only', firstId]);
      const [stillIsolated] = await target.pool.execute('SELECT `name` FROM `buildings` WHERE `id` = ?', [firstId]);
      if (stillIsolated[0]?.name !== rows1[0].name) {
        throw new Error('TENANT_DATABASE_NAMESPACE_ISOLATION_FAILED_' + appId);
      }
      const [decoy] = await target.pool.execute('SELECT `id` FROM `buildings` WHERE `id` = ?', [secondId]);
      if (decoy.length !== 0) throw new Error('TENANT_DATA_MIGRATION_CROSS_ORG_LEAK_' + appId);
      console.log('PASS: ' + appId + ' org-scoped MariaDB copy, org_id removal, reconciliation and independent tenant DB namespace');
    }
  } finally {
    for (const fixture of fixtures) {
      try { await fixture.sourcePool.execute('DELETE FROM `buildings` WHERE `id` = ? AND `org_id` = ?', [fixture.firstId, fixture.sourceOrgId]); } catch (_) {}
    }
    for (const pool of targetPools) await pool.end();
    for (const pool of sourcePools) await pool.end();
    for (const database of createdDatabases) {
      try { await adminPool.execute('DROP DATABASE `' + database + '`'); } catch (_) {}
    }
    await adminPool.end();
  }
}

main().catch(error => {
  console.error(error.code || error.message || 'TENANT_DATA_MIGRATION_MARIADB_TEST_FAILED');
  process.exitCode = 1;
});
