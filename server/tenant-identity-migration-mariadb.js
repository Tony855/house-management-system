'use strict';

const { APP_IDS } = require('./tenant-registry');
const { tenantDatabaseName } = require('./tenant-provisioner');
const { TABLES } = require('./tenant-identity-migration');

const QUERIES = Object.freeze({
  users: 'SELECT * FROM users WHERE org_id = ? AND mode = ? ORDER BY id ASC',
  roles: 'SELECT r.* FROM roles r WHERE r.org_id = ? OR (r.org_id IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.org_id = ? AND u.mode = ? AND u.role = r.code)) ORDER BY r.id ASC',
  settings: 'SELECT * FROM settings WHERE org_id = ? ORDER BY org_id ASC',
  user_permissions: 'SELECT up.* FROM user_permissions up JOIN users u ON u.id = up.user_id WHERE u.org_id = ? AND u.mode = ? ORDER BY up.id ASC',
  role_permissions: 'SELECT rp.* FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE (r.org_id = ? OR (r.org_id IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.org_id = ? AND u.mode = ? AND u.role = r.code))) AND (rp.org_id = 0 OR rp.org_id = ?) ORDER BY rp.id ASC'
});
const TARGET_SELECT = Object.freeze({
  users: 'SELECT * FROM users ORDER BY id ASC',
  roles: 'SELECT * FROM roles ORDER BY id ASC',
  settings: 'SELECT currency, rate, net_price_per_mb, water_price, elec_price, item_lib, remind_enable, remind_days FROM settings ORDER BY id ASC',
  user_permissions: 'SELECT id, user_id, page FROM user_permissions ORDER BY id ASC',
  role_permissions: 'SELECT role_id, page FROM role_permissions ORDER BY role_id ASC, page ASC'
});
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function q(value) {
  if (!IDENTIFIER.test(value)) throw new TypeError('TENANT_IDENTITY_SQL_IDENTIFIER_INVALID');
  return '`' + value + '`';
}
async function assertDb(db, expected, code) {
  const [rows] = await db.execute('SELECT DATABASE() AS databaseName');
  if (rows[0]?.databaseName !== expected) throw new Error(code);
}
function assertPool(pool, method, code) {
  if (!pool || typeof pool[method] !== 'function') throw new TypeError(code);
}

function createMariaDbTenantIdentityAdapters({ sourcePool, targetPool, tenantId }) {
  if (!ID_RE.test(tenantId || '')) throw new TypeError('TENANT_IDENTITY_MIGRATION_IDENTITY_INVALID');
  assertPool(sourcePool, 'execute', 'TENANT_IDENTITY_SOURCE_POOL_REQUIRED');
  assertPool(targetPool, 'execute', 'TENANT_IDENTITY_TARGET_POOL_REQUIRED');
  assertPool(targetPool, 'getConnection', 'TENANT_IDENTITY_TARGET_CONNECTION_REQUIRED');

  const sourceReader = Object.freeze({
    async exportTenantIdentity({ appId, tenantId: requestedTenant, sourceOrgId }) {
      if (!APP_IDS.has(appId) || requestedTenant !== tenantId || !Number.isSafeInteger(sourceOrgId) || sourceOrgId < 1) {
        throw new TypeError('TENANT_IDENTITY_MIGRATION_SOURCE_SCOPE_INVALID');
      }
      await assertDb(sourcePool, 'house_sys', 'TENANT_IDENTITY_SOURCE_DATABASE_MISMATCH');
      const params = {
        users: [sourceOrgId, appId],
        roles: [sourceOrgId, sourceOrgId, appId],
        settings: [sourceOrgId],
        user_permissions: [sourceOrgId, appId],
        role_permissions: [sourceOrgId, sourceOrgId, appId, sourceOrgId]
      };
      const snapshot = {};
      for (const table of TABLES) {
        const [rows] = await sourcePool.execute(QUERIES[table], params[table]);
        snapshot[table] = rows;
      }
      const [sessions] = await sourcePool.execute(
        'SELECT COUNT(*) AS total FROM sessions WHERE org_id = ? AND mode = ?', [sourceOrgId, appId]
      );
      snapshot.legacySessionCount = Number(sessions[0]?.total || 0);
      return snapshot;
    }
  });

  const targetWriter = Object.freeze({
    async importTenantIdentity({ appId, tenantId: requestedTenant, tables }) {
      if (!APP_IDS.has(appId) || requestedTenant !== tenantId ||
          JSON.stringify(Object.keys(tables || {}).sort()) !== JSON.stringify([...TABLES].sort())) {
        throw new Error('TENANT_IDENTITY_MIGRATION_TARGET_SCOPE_INVALID');
      }
      const connection = await targetPool.getConnection();
      const lockName = 'tenant-identity-' + tenantId;
      let lockAcquired = false;
      try {
        await assertDb(connection, tenantDatabaseName(appId, tenantId), 'TENANT_IDENTITY_TARGET_DATABASE_MISMATCH');
        const [locks] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
        if (Number(locks[0]?.acquired) !== 1) throw new Error('TENANT_IDENTITY_MIGRATION_LOCK_UNAVAILABLE');
        lockAcquired = true;
        await connection.beginTransaction();
        for (const table of TABLES) {
          const [rows] = await connection.execute('SELECT COUNT(*) AS total FROM ' + q(table));
          if (Number(rows[0]?.total || 0) !== 0) throw new Error('TENANT_IDENTITY_MIGRATION_TARGET_NOT_EMPTY');
        }
        for (const table of TABLES) {
          const rows = tables[table];
          if (!Array.isArray(rows)) throw new Error('TENANT_IDENTITY_MIGRATION_ROWS_INVALID');
          for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row) || Object.hasOwn(row, 'org_id')) {
              throw new Error('TENANT_IDENTITY_MIGRATION_COLUMNS_INVALID');
            }
          }
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]).sort();
          if (!columns.length || rows.some(row => Object.keys(row).sort().join('\0') !== columns.join('\0'))) {
            throw new Error('TENANT_IDENTITY_MIGRATION_COLUMNS_INVALID');
          }
          columns.forEach(q);
          const sql = 'INSERT INTO ' + q(table) + ' (' + columns.map(q).join(', ') + ') VALUES ' +
            rows.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
          await connection.execute(sql, rows.flatMap(row => columns.map(column => row[column])));
        }
        await connection.commit();
        return { imported: true };
      } catch (error) {
        try { await connection.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      } finally {
        let destroy = false;
        if (lockAcquired) {
          try {
            const [released] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
            if (Number(released[0]?.released) !== 1) destroy = true;
          } catch (_) { destroy = true; }
        }
        if (destroy && typeof connection.destroy === 'function') connection.destroy();
        else connection.release();
      }
    }
  });

  const targetReader = Object.freeze({
    async readTenantIdentity({ appId, tenantId: requestedTenant }) {
      if (!APP_IDS.has(appId) || requestedTenant !== tenantId) throw new TypeError('TENANT_IDENTITY_MIGRATION_TARGET_SCOPE_INVALID');
      await assertDb(targetPool, tenantDatabaseName(appId, tenantId), 'TENANT_IDENTITY_TARGET_DATABASE_MISMATCH');
      const tables = {};
      for (const table of TABLES) {
        const [rows] = await targetPool.execute(TARGET_SELECT[table]);
        tables[table] = rows;
      }
      return { tables };
    }
  });

  return Object.freeze({ sourceReader, targetWriter, targetReader });
}
module.exports = { createMariaDbTenantIdentityAdapters };
