'use strict';

const { APP_IDS } = require('./tenant-registry');
const { TABLES } = require('./tenant-repository');
const { tenantDatabaseName } = require('./tenant-provisioner');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BATCH_SIZE = 200;

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('TENANT_MIGRATION_SQL_IDENTIFIER_INVALID');
  return '`' + value + '`';
}

async function assertDatabase(queryable, expected, code) {
  const [rows] = await queryable.execute('SELECT DATABASE() AS databaseName');
  if (rows[0]?.databaseName !== expected) throw new Error(code);
}

function assertPool(pool, method, code) {
  if (!pool || typeof pool[method] !== 'function') throw new TypeError(code);
}

/**
 * Creates concrete mysql2-compatible migration adapters.
 * sourcePool must be connected with a read-only DB principal restricted to the
 * legacy database. targetPool must be connected with a tenant-specific principal.
 */
function createMariaDbTenantMigrationAdapters({ appId, sourcePool, targetPool }) {
  if (!APP_IDS.has(appId)) throw new TypeError('TENANT_DATA_MIGRATION_APP_INVALID');
  assertPool(sourcePool, 'execute', 'TENANT_MIGRATION_SOURCE_POOL_REQUIRED');
  assertPool(targetPool, 'execute', 'TENANT_MIGRATION_TARGET_POOL_REQUIRED');
  assertPool(targetPool, 'getConnection', 'TENANT_MIGRATION_TARGET_CONNECTION_REQUIRED');
  const tables = [...TABLES[appId]].sort();

  const sourceReader = Object.freeze({
    async exportOrgSnapshot({ appId: requestedAppId, sourceOrgId }) {
      if (requestedAppId !== appId || !Number.isSafeInteger(sourceOrgId) || sourceOrgId < 1) {
        throw new TypeError('TENANT_DATA_MIGRATION_SOURCE_SCOPE_INVALID');
      }
      await assertDatabase(sourcePool, 'house_sys_' + appId, 'TENANT_DATA_MIGRATION_SOURCE_DATABASE_MISMATCH');
      const result = {};
      for (const table of tables) {
        const [rows] = await sourcePool.execute(
          'SELECT * FROM ' + quoteIdentifier(table) + ' WHERE `org_id` = ? ORDER BY `id` ASC',
          [sourceOrgId]
        );
        result[table] = rows;
      }
      return { tables: result };
    }
  });

  const targetWriter = Object.freeze({
    async importTenantSnapshot({ appId: requestedAppId, tenantId, tables: snapshotTables }) {
      if (requestedAppId !== appId || typeof tenantId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
        throw new TypeError('TENANT_DATA_MIGRATION_TARGET_SCOPE_INVALID');
      }
      if (!snapshotTables || JSON.stringify(Object.keys(snapshotTables).sort()) !== JSON.stringify(tables)) {
        throw new Error('TENANT_DATA_MIGRATION_TARGET_TABLE_SET_MISMATCH');
      }
      const connection = await targetPool.getConnection();
      const lockName = 'tenant-migrate-' + tenantId;
      let lockAcquired = false;
      try {
        await assertDatabase(connection, tenantDatabaseName(appId, tenantId), 'TENANT_DATA_MIGRATION_TARGET_DATABASE_MISMATCH');
        const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
        if (Number(lockRows[0]?.acquired) !== 1) throw new Error('TENANT_DATA_MIGRATION_LOCK_UNAVAILABLE');
        lockAcquired = true;
        await connection.beginTransaction();
        // Never overwrite or append into a partially migrated tenant database.
        for (const table of tables) {
          const [rows] = await connection.execute('SELECT COUNT(*) AS total FROM ' + quoteIdentifier(table));
          if (Number(rows[0]?.total || 0) !== 0) throw new Error('TENANT_DATA_MIGRATION_TARGET_NOT_EMPTY');
        }

        for (const table of tables) {
          const rows = snapshotTables[table];
          if (!Array.isArray(rows)) throw new Error('TENANT_DATA_MIGRATION_TARGET_ROWS_INVALID');
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]).sort();
          if (!columns.length || columns.includes('org_id')) throw new Error('TENANT_DATA_MIGRATION_TARGET_COLUMNS_INVALID');
          columns.forEach(quoteIdentifier);
          for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row) ||
                Object.keys(row).sort().join('\0') !== columns.join('\0') || Object.hasOwn(row, 'org_id')) {
              throw new Error('TENANT_DATA_MIGRATION_TARGET_COLUMNS_INVALID');
            }
          }
          const names = columns.map(quoteIdentifier).join(', ');
          for (let start = 0; start < rows.length; start += BATCH_SIZE) {
            const batch = rows.slice(start, start + BATCH_SIZE);
            const tuple = '(' + columns.map(() => '?').join(', ') + ')';
            const valuesSql = batch.map(() => tuple).join(', ');
            const values = batch.flatMap(row => columns.map(column => row[column]));
            await connection.execute(
              'INSERT INTO ' + quoteIdentifier(table) + ' (' + names + ') VALUES ' + valuesSql,
              values
            );
          }
        }
        await connection.commit();
        return { imported: true, tableCount: tables.length };
      } catch (error) {
        try { await connection.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      } finally {
        let discardConnection = false;
        if (lockAcquired) {
          try {
            const [releaseRows] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
            if (Number(releaseRows[0]?.released) !== 1) discardConnection = true;
          } catch (_) {
            // Never return a pooled connection with an advisory lock to the pool.
            discardConnection = true;
          }
        }
        if (discardConnection && typeof connection.destroy === 'function') connection.destroy();
        else connection.release();
      }
    }
  });

  const targetReader = Object.freeze({
    async readTenantSnapshot({ appId: requestedAppId, tenantId }) {
      if (requestedAppId !== appId || typeof tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
        throw new TypeError('TENANT_DATA_MIGRATION_TARGET_SCOPE_INVALID');
      }
      await assertDatabase(targetPool, tenantDatabaseName(appId, tenantId), 'TENANT_DATA_MIGRATION_TARGET_DATABASE_MISMATCH');
      const result = {};
      for (const table of tables) {
        const [rows] = await targetPool.execute('SELECT * FROM ' + quoteIdentifier(table) + ' ORDER BY `id` ASC');
        result[table] = rows;
      }
      return { tables: result };
    }
  });

  return Object.freeze({ sourceReader, targetWriter, targetReader });
}

module.exports = { createMariaDbTenantMigrationAdapters };
