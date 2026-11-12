'use strict';

const TABLES = Object.freeze({
  rental: new Set(['buildings', 'rooms', 'tenants', 'contracts', 'meters', 'room_net_lines', 'net_changes', 'net_requests', 'bills', 'bill_transactions', 'repairs']),
  hotel: new Set(['buildings', 'rooms', 'tenants', 'orders', 'bills', 'repairs']),
  property: new Set(['buildings', 'rooms', 'tenants', 'org_employees', 'meters', 'room_net_lines', 'net_changes', 'net_requests', 'bills', 'repairs', 'complaints'])
});
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Public product projections intentionally omit identity documents, credentials,
// photos and other sensitive fields. Add a field only after an explicit API review.
const COLUMNS = Object.freeze({
  rental: Object.freeze({
    buildings: ['id', 'name', 'address', 'remark', 'created_at'],
    rooms: ['id', 'building_id', 'room_no', 'floor', 'area', 'rent', 'deposit', 'status', 'room_type', 'is_dorm', 'capacity', 'water_price', 'elec_price', 'remark', 'created_at'],
    tenants: ['id', 'name', 'gender', 'phone', 'remark', 'created_at'],
    contracts: ['id', 'contract_no', 'room_id', 'tenant_id', 'start_date', 'end_date', 'rent', 'deposit', 'pay_cycle', 'sign_date', 'status', 'remark', 'created_at'],
    meters: ['id', 'room_id', 'month', 'water_prev', 'water_curr', 'water_usage', 'water_fee', 'elec_prev', 'elec_curr', 'elec_usage', 'elec_fee', 'remark', 'created_at'],
    room_net_lines: ['id', 'room_id', 'line_name', 'bandwidth', 'start_date', 'status', 'stop_date', 'remark', 'created_at'],
    net_changes: ['id', 'room_id', 'line_id', 'change_date', 'change_type', 'old_bandwidth', 'new_bandwidth', 'remark', 'created_at'],
    net_requests: ['id', 'company_id', 'room_id', 'type', 'bandwidth', 'delta', 'line_id', 'reason', 'status', 'created_by', 'created_at', 'handled_by', 'handle_note', 'handled_at'],
    bills: ['id', 'source', 'room_id', 'tenant_id', 'contract_id', 'order_id', 'period_start', 'period_end', 'due_date', 'amount', 'paid_amount', 'status', 'pay_method', 'pay_date', 'remark', 'created_at'],
    bill_transactions: ['id', 'bill_id', 'transaction_type', 'amount', 'pay_method', 'external_reference', 'note', 'request_id', 'transaction_date', 'created_at'],
    repairs: ['id', 'room_id', 'title', 'content', 'status', 'handler', 'handle_note', 'created_at']
  }),
  hotel: Object.freeze({
    buildings: ['id', 'name', 'address', 'remark', 'created_at'],
    rooms: ['id', 'building_id', 'room_no', 'floor', 'area', 'day_price', 'deposit', 'status', 'room_type', 'is_dorm', 'capacity', 'remark', 'created_at'],
    tenants: ['id', 'name', 'gender', 'phone', 'remark', 'created_at'],
    orders: ['id', 'order_no', 'room_id', 'guest_id', 'check_in_date', 'check_out_date', 'days', 'day_price', 'total', 'deposit', 'status', 'checkin_time', 'checkout_time', 'remark', 'created_at'],
    bills: ['id', 'source', 'room_id', 'tenant_id', 'order_id', 'period_start', 'period_end', 'due_date', 'amount', 'paid_amount', 'status', 'pay_method', 'pay_date', 'remark', 'created_at'],
    repairs: ['id', 'room_id', 'title', 'content', 'status', 'handler', 'handle_note', 'created_at']
  }),
  property: Object.freeze({
    buildings: ['id', 'name', 'address', 'remark', 'created_at'],
    rooms: ['id', 'building_id', 'room_no', 'floor', 'area', 'status', 'room_type', 'owner_id', 'property_fee', 'is_dorm', 'capacity', 'water_price', 'elec_price', 'remark', 'created_at'],
    tenants: ['id', 'name', 'contact', 'phone', 'remark', 'created_at'],
    org_employees: ['id', 'company', 'owner_id', 'room_id', 'name', 'phone', 'department', 'position', 'remark', 'created_at'],
    meters: ['id', 'room_id', 'month', 'water_prev', 'water_curr', 'water_usage', 'water_fee', 'elec_prev', 'elec_curr', 'elec_usage', 'elec_fee', 'remark', 'created_at'],
    room_net_lines: ['id', 'room_id', 'line_name', 'bandwidth', 'start_date', 'status', 'stop_date', 'remark', 'created_at'],
    net_changes: ['id', 'room_id', 'line_id', 'change_date', 'change_type', 'old_bandwidth', 'new_bandwidth', 'remark', 'created_at'],
    net_requests: ['id', 'company_id', 'room_id', 'type', 'bandwidth', 'delta', 'line_id', 'reason', 'status', 'created_by', 'created_at', 'handled_by', 'handle_note', 'handled_at'],
    bills: ['id', 'source', 'room_id', 'tenant_id', 'order_id', 'period_start', 'period_end', 'due_date', 'amount', 'paid_amount', 'status', 'pay_method', 'pay_date', 'remark', 'created_at'],
    repairs: ['id', 'room_id', 'title', 'content', 'status', 'handler', 'handle_note', 'created_at'],
    complaints: ['id', 'room_id', 'title', 'content', 'status', 'handler', 'handle_note', 'created_at']
  })
});

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('TENANT_SQL_IDENTIFIER_INVALID');
  return '`' + value + '`';
}
function assertTable(appId, table) {
  if (!TABLES[appId] || !TABLES[appId].has(table)) throw new TypeError('TENANT_TABLE_NOT_ALLOWED');
  return identifier(table);
}
function assertColumn(appId, table, column) {
  if (typeof column !== 'string' || !COLUMNS[appId]?.[table]?.includes(column)) {
    throw new TypeError('TENANT_COLUMN_NOT_ALLOWED');
  }
  return identifier(column);
}
function assertWriteColumn(appId, table, column) {
  if (table === 'tenants' && (
    (['rental', 'hotel'].includes(appId) && column === 'id_card') ||
    (appId === 'property' && column === 'license_no')
  )) return identifier(column);
  return assertColumn(appId, table, column);
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

  async function list(table, { columns = COLUMNS[appId]?.[table], filters = {}, orderBy = 'id', direction = 'ASC', limit = 50, offset = 0 } = {}) {
    const tableSql = assertTable(appId, table);
    if (!Array.isArray(columns) || !columns.length) throw new TypeError('TENANT_COLUMNS_INVALID');
    columns.forEach(column => assertColumn(appId, table, column));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw new TypeError('TENANT_PAGINATION_INVALID');
    }
    const where = normalizeFilters(filters);
    where.forEach(([key]) => assertColumn(appId, table, key));
    if (direction !== 'ASC' && direction !== 'DESC') throw new TypeError('TENANT_ORDER_INVALID');
    const whereSql = where.length ? ' WHERE ' + where.map(([key]) => identifier(key) + ' = ?').join(' AND ') : '';
    const orderSql = orderBy === null ? '' : ' ORDER BY ' + assertColumn(appId, table, orderBy) + ' ' + direction;
    const [rows] = await queryable.execute(
      'SELECT ' + columns.map(column => identifier(column)).join(', ') +
      ' FROM ' + tableSql + whereSql + orderSql + ' LIMIT ? OFFSET ?',
      [...where.map(([, value]) => value), limit, offset]
    );
    return rows;
  }

  async function findById(table, id, columns = COLUMNS[appId]?.[table]) {
    const rows = await list(table, { columns, filters: { id }, limit: 1, offset: 0, orderBy: null });
    return rows[0] || null;
  }

  async function count(table, filters = {}) {
    const tableSql = assertTable(appId, table);
    const where = normalizeFilters(filters);
    where.forEach(([key]) => assertColumn(appId, table, key));
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
    entries.forEach(([key]) => assertWriteColumn(appId, table, key));
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
    entries.forEach(([key]) => assertWriteColumn(appId, table, key));
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

  const transactionExecute = allowTransactions ? undefined : (sql, params = []) => queryable.execute(sql, params);
  return Object.freeze({ appId, list, findById, count, insert, updateById, deleteById, withTransaction, ...(transactionExecute ? { execute: transactionExecute } : {}) });
}

module.exports = { TABLES, COLUMNS, createTenantRepository };
