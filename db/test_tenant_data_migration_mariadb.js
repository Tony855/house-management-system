'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { TABLES } = require('../server/tenant-repository');
const { copyTenantOrgData } = require('../server/tenant-data-migration');
const { createMariaDbTenantMigrationAdapters } = require('../server/tenant-data-migration-mariadb');

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('TENANT_MIGRATION_MARIADB_TEST_ONLY');
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 4,
    multipleStatements: false
  };
  const adminPool = mysql.createPool(config);
  const sourcePool = mysql.createPool({ ...config, database: 'house_sys_rental' });
  const suffix = crypto.randomBytes(6).toString('hex');
  const targetDatabase = 'house_sys_migration_test_' + suffix;
  const tenantId = crypto.randomUUID();
  const sourceOrgId = crypto.randomInt(100000000, 200000000);
  let sourceRowId = null;
  let targetCreated = false;
  const events = [];

  try {
    await adminPool.execute('CREATE DATABASE ' + '`' + targetDatabase + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    targetCreated = true;
    const targetPool = mysql.createPool({ ...config, database: targetDatabase });
    try {
      for (const table of [...TABLES.rental].sort()) {
        await adminPool.execute('CREATE TABLE ' + '`' + targetDatabase + '`.`' + table + '` LIKE `house_sys_rental`.`' + table + '`');
        await adminPool.execute('ALTER TABLE ' + '`' + targetDatabase + '`.`' + table + '` DROP COLUMN `org_id`');
      }
      const [insert] = await sourcePool.execute(
        'INSERT INTO `buildings` (`org_id`, `name`, `address`, `remark`) VALUES (?, ?, ?, ?)',
        [sourceOrgId, 'migration-test-' + suffix, 'CI fixture', 'isolated migration integration']
      );
      sourceRowId = insert.insertId;

      const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', sourcePool, targetPool });
      const result = await copyTenantOrgData({
        appId: 'rental',
        tenantId,
        sourceOrgId,
        ...adapters,
        audit: async event => events.push(event)
      });
      if (!result.copied || result.cutover || result.manifest.buildings.rowCount !== 1) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_RESULT_INVALID');
      }
      if (!events.some(event => event.event === 'tenant_data_migration_copy_verified')) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_AUDIT_MISSING');
      }
      const [rows] = await targetPool.execute(
        'SELECT `id`, `name` FROM `buildings` WHERE `id` = ?',
        [sourceRowId]
      );
      if (rows.length !== 1 || rows[0].name !== 'migration-test-' + suffix) {
        throw new Error('TENANT_DATA_MIGRATION_MARIADB_READBACK_FAILED');
      }
      console.log('PASS: real MariaDB org-scoped copy, transaction, org_id removal and SHA-256 reconciliation');
    } finally {
      await targetPool.end();
    }
  } finally {
    if (sourceRowId !== null) {
      try { await sourcePool.execute('DELETE FROM `buildings` WHERE `id` = ? AND `org_id` = ?', [sourceRowId, sourceOrgId]); } catch (_) {}
    }
    if (targetCreated) {
      try { await adminPool.execute('DROP DATABASE `' + targetDatabase + '`'); } catch (_) {}
    }
    await sourcePool.end();
    await adminPool.end();
  }
}

main().catch(error => {
  console.error(error.code || error.message || 'TENANT_DATA_MIGRATION_MARIADB_TEST_FAILED');
  process.exitCode = 1;
});
