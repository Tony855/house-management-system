'use strict';

const SAFE_TENANT_COLUMNS = 'tenant_uuid, app_id, display_label, lifecycle_state, schema_version, created_at, updated_at';

function createPlatformRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
    throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  }
  return {
    async overview() {
      const [[tenants]] = await pool.query(
        'SELECT COUNT(*) AS total, SUM(lifecycle_state = ?) AS active, SUM(lifecycle_state = ?) AS suspended FROM platform_tenants',
        ['active', 'suspended']);
      const [[subscriptions]] = await pool.query(
        'SELECT COUNT(*) AS total, SUM(status = ?) AS active, SUM(status = ?) AS past_due FROM platform_subscriptions',
        ['active', 'past_due']);
      const [[invoices]] = await pool.query(
        'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = ? THEN total_minor ELSE 0 END), 0) AS outstanding_minor FROM platform_invoices',
        ['open']);
      const [[payments]] = await pool.query(
        'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = ? THEN amount_minor ELSE 0 END), 0) AS received_minor FROM platform_payment_transactions',
        ['succeeded']);
      return { tenants, subscriptions, invoices, payments };
    },
    async listProducts() {
      const [rows] = await pool.query('SELECT product_code, display_name, status, created_at FROM platform_products ORDER BY product_code');
      return rows;
    },
    async listPlans({ productCode, status, limit = 100, offset = 0 } = {}) {
      const where = [], values = [];
      if (productCode) { where.push('product_code = ?'); values.push(productCode); }
      if (status) { where.push('status = ?'); values.push(status); }
      values.push(limit, offset);
      const [rows] = await pool.query(
        'SELECT id, product_code, plan_code, display_name, billing_interval, amount_minor, currency, trial_days, limits_json, features_json, status, created_at, updated_at FROM platform_plans' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY product_code, id DESC LIMIT ? OFFSET ?', values);
      return rows;
    },
    async createPlan(input, audit) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.query(
          'INSERT INTO platform_plans (product_code, plan_code, display_name, billing_interval, amount_minor, currency, trial_days, limits_json, features_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [input.productCode, input.planCode, input.displayName, input.interval, input.amountMinor, input.currency, input.trialDays, JSON.stringify(input.limits || {}), JSON.stringify(input.features || {}), 'draft']);
        await connection.query(
          'INSERT INTO platform_billing_audit (admin_id, action, target_type, target_id, reason, after_json, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [audit.adminId, 'plan.created', 'plan', String(result.insertId), audit.reason, JSON.stringify({ ...input, status: 'draft' }), audit.requestId || null]);
        await connection.commit();
        return { id: result.insertId, status: 'draft' };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async listTenants({ appId, state, limit = 100, offset = 0 } = {}) {
      const where = [], values = [];
      if (appId) { where.push('app_id = ?'); values.push(appId); }
      if (state) { where.push('lifecycle_state = ?'); values.push(state); }
      values.push(limit, offset);
      const [rows] = await pool.query(
        'SELECT ' + SAFE_TENANT_COLUMNS + ' FROM platform_tenants' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', values);
      return rows;
    },
    async listInvoices({ tenantId, status, limit = 100, offset = 0 } = {}) {
      const where = [], values = [];
      if (tenantId) { where.push('tenant_uuid = ?'); values.push(tenantId); }
      if (status) { where.push('status = ?'); values.push(status); }
      values.push(limit, offset);
      const [rows] = await pool.query(
        'SELECT id, invoice_no, tenant_uuid, subscription_id, billing_period_start, billing_period_end, currency, subtotal_minor, discount_minor, tax_minor, total_minor, status, issued_at, due_at, paid_at, created_at FROM platform_invoices' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', values);
      return rows;
    },
    async listLedger({ tenantId, currency, limit = 100, offset = 0 } = {}) {
      const where = [], values = [];
      if (tenantId) { where.push('tenant_uuid = ?'); values.push(tenantId); }
      if (currency) { where.push('currency = ?'); values.push(currency); }
      values.push(limit, offset);
      const [rows] = await pool.query(
        'SELECT id, tenant_uuid, invoice_id, payment_id, refund_id, entry_type, amount_minor, currency, reference_key, created_at FROM platform_ledger_entries' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', values);
      return rows;
    }
  };
}

module.exports = { createPlatformRepository };
