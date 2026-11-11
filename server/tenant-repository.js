'use strict';

const TABLES = Object.freeze({
  rental: new Set(['buildings', 'rooms', 'tenants', 'contracts', 'meters', 'room_net_lines', 'net_changes', 'net_requests', 'bills', 'repairs']),
  hotel: new Set(['buildings', 'rooms', 'tenants', 'orders', 'bills', 'repairs']),
  property: new Set(['buildings', 'rooms', 'tenants', 'org_employees', 'meters', 'room_net_lines', 'net_changes', 'net_requests', 'bills', 'repairs', 'complaints'])
});
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('TENANT_SQL_IDENTIFIER_INVALID');
  return '`' + value + '`';
}
function assertTable(appId, table) {
  if (!TABLES[appId] || !TABLES[appId].has(table)) throw new TypeError('TENANT_TABLE_NOT_ALLOWED');
  return identifier(table);
}
function normalizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('TENANT_FIELDS_INVALID');
  const entries = Object.entries(fields);
  if (!entries.length || entries.some(([key]) => !IDENTIFIER.test(key))) throw new TypeError('TENANT_FIELDS_INVALID');
  return entries;
}
function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new TypeError('TENANT_FILTERS_INVALID');
  const entries = Object.entries(filters);
  if (entries.some(([key]) => !IDENTIFIER.test(key))) throw new TypeError('TENANT_FILTERS_INVALID');
  return entries;
}

function createTenantRepository({ pool, appId, queryable = pool, allowTransactions = true }) {
  if (!TABLES[appId]) throw new TypeError('TENANT_REPOSITORY_APP_INVALID');
  if (!queryable || typeof queryable.execute !== 'function') throw new TypeError('TENANT_REPOSITORY_POOL_REQUIRED');

  async function list(table, { columns = ['*'], filters = {}, orderBy = 'id', direction = 'ASC', limit = 50, offset = 0 } = {}) {
    const tableSql = assertTable(appId, table);
    if (!Array.isArray(columns) || !columns.length || columns.some(column => column !== '*' && !IDENTIFIER.test(column))) {
      throw new TypeError('TENANT_COLUMNS_INVALID');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw new TypeError('TENANT_PAGINATION_INVALID');
    }
    const where = normalizeFilters(filters);
    if (direction !== 'ASC' && direction !== 'DESC') throw new TypeError('TENANT_ORDER_INVALID');
    const whereSql = where.length ? ' WHERE ' + where.map(([key]) => identifier(key) + ' = ?').join(' AND ') : '';
    const orderSql = orderBy === null ? '' : ' ORDER BY ' + identifier(orderBy) + ' ' + direction;
    const [rows] = await queryable.execute(
      'SELECT ' + columns.map(column => column === '*' ? '*' : identifier(column)).join(', ') +
      ' FROM ' + tableSql + whereSql + orderSql + ' LIMIT ? OFFSET ?',
      [...where.map(([, value]) => value), limit, offset]
    );
    return rows;
  }

  async function findById(table, id, columns = ['*']) {
    const rows = await list(table, { columns, filters: { id }, limit: 1, offset: 0, orderBy: null });
    return rows[0] || null;
  }

  async function count(table, filters = {}) {
    const tableSql = assertTable(appId, table);
    const where = normalizeFilters(filters);
    const whereSql = where.length ? ' WHERE ' + where.map(([key]) => identifier(key) + ' = ?').join(' AND ') : '';
    const [rows] = await queryable.execute(
      'SELECT COUNT(*) AS total FROM ' + tableSql + whereSql,
      where.map(([, value]) => value)
    );
    return Number(rows[0]?.total || 0);
  }

  async function insert(table, fields) {
    const tableSql = assertTable(appId, table);
    const entries = normalizeFields(fields);
    const [result] = await queryable.execute(
      'INSERT INTO ' + tableSql + ' (' + entries.map(([key]) => identifier(key)).join(', ') + ')' +
      ' VALUES (' + entries.map(() => '?').join(', ') + ')',
      entries.map(([, value]) => value)
    );
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  }

  async function updateById(table, id, fields) {
    const tableSql = assertTable(appId, table);
    const entries = normalizeFields(fields);
    if (entries.some(([key]) => key === 'id')) throw new TypeError('TENANT_PRIMARY_KEY_IMMUTABLE');
    const [result] = await queryable.execute(
      'UPDATE ' + tableSql + ' SET ' + entries.map(([key]) => identifier(key) + ' = ?').join(', ') + ' WHERE `id` = ?',
      [...entries.map(([, value]) => value), id]
    );
    return { affectedRows: result.affectedRows };
  }

  async function deleteById(table, id) {
    const tableSql = assertTable(appId, table);
    const [result] = await queryable.execute('DELETE FROM ' + tableSql + ' WHERE `id` = ?', [id]);
    return { affectedRows: result.affectedRows };
  }

  async function withTransaction(callback) {
    if (!allowTransactions || typeof pool.getConnection !== 'function') throw new TypeError('TENANT_TRANSACTION_UNAVAILABLE');
    if (typeof callback !== 'function') throw new TypeError('TENANT_TRANSACTION_CALLBACK_REQUIRED');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = createTenantRepository({ pool, appId, queryable: connection, allowTransactions: false });
      const result = await callback(tx);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  return Object.freeze({ appId, list, findById, count, insert, updateById, deleteById, withTransaction });
}

module.exports = { TABLES, createTenantRepository };
