'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { TABLES } = require('../server/tenant-repository');
const { copyTenantOrgData } = require('../server/tenant-data-migration');
const { createMariaDbTenantMigrationAdapters } = require('../server/tenant-data-migration-mariadb');

const APPS = ['rental', 'hotel', 'property'];

async function createTenantDatabase(adminPool, config, sourceDatabase, appId, suffix) {
  const database = 'house_sys_mig_' + appId + '_' + suffix;
  await adminPool.execute('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  const pool = mysql.createPool({ ...config, database });
  for (const table of [...TABLES[appId]].sort()) {
    await adminPool.execute(
      'CREATE TABLE `' + database + '`.`' + table + '` LIKE `' + sourceDatabase + '`.`' + table + '`'
    );
    await adminPool.execute('ALTER TABLE `' + database + '`.`' + table + '` DROP COLUMN `org_id`');
  }
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
      const decoyOrgId = sourceOrgId + 1;
      const tenantId = crypto.randomUUID();
      const tenantId2 = crypto.randomUUID();

      const [insert] = await sourcePool.execute(
        'INSERT INTO `buildings` (`org_id`, `name`, `address`, `remark`) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        [sourceOrgId, 'migration-' + appId + '-' + suffix, 'CI fixture', 'selected org',
         decoyOrgId, 'decoy-' + appId + '-' + suffix, 'Other org', 'must not migrate']
      );
      const firstId = insert.insertId;
      const secondId = firstId + 1;
      fixtures.push({ sourcePool, firstId, sourceOrgId }, { sourcePool, firstId: secondId, sourceOrgId: decoyOrgId });

      const target = await createTenantDatabase(adminPool, config, sourceDatabase, appId, suffix + 'a');
      const target2 = await createTenantDatabase(adminPool, config, sourceDatabase, appId, suffix + 'b');
      createdDatabases.push(target.database, target2.database);
      targetPools.push(target.pool, target2.pool);

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
      await copyTenantOrgData({
        appId, tenantId: tenantId2, sourceOrgId, mode: 'copy', ...adapters2,
        audit: async () => {}
      });
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
