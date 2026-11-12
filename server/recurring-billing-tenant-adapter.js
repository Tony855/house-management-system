'use strict';

const { resolveTenantContext } = require('./tenant-registry');

function dateOnly(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T| )/.test(value)) return value.slice(0, 10);
  return '';
}

function createRecurringBillingTenantAdapter({ registry, secretProvider, tenantPoolManager }) {
  if (!registry || typeof registry.findTenantById !== 'function') throw new TypeError('BILLING_TENANT_REGISTRY_REQUIRED');
  if (!secretProvider || typeof secretProvider.getDatabaseCredentials !== 'function') throw new TypeError('BILLING_TENANT_SECRET_PROVIDER_REQUIRED');
  if (!tenantPoolManager || typeof tenantPoolManager.getPool !== 'function') throw new TypeError('BILLING_TENANT_POOL_MANAGER_REQUIRED');

  return Object.freeze({
    async enqueueTenantJob(input) {
      if (!input || !['rental', 'property'].includes(input.appId) ||
          input.jobType !== (input.appId === 'rental' ? 'rental_bill' : 'property_fee') ||
          typeof input.tenantId !== 'string' || typeof input.periodKey !== 'string' ||
          typeof input.requestId !== 'string' || input.requestId.length > 128) {
        throw Object.assign(new Error('BILLING_TENANT_JOB_INPUT_INVALID'), { code: 'BILLING_TENANT_JOB_INPUT_INVALID' });
      }
      const context = await resolveTenantContext({
        auth: { authenticated: true, tenantId: input.tenantId, appId: input.appId },
        appId: input.appId, registry, secretProvider
      });
      const pool = await tenantPoolManager.getPool(context);
      if (input.appId === 'rental') {
        const [year, month, day] = input.periodKey.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodKey) ||
            date.toISOString().slice(0, 10) !== input.periodKey) {
          throw Object.assign(new Error('RECURRING_BILLING_PERIOD_INVALID'), { code: 'RECURRING_BILLING_PERIOD_INVALID' });
        }
        await pool.query(
          "INSERT INTO rental_bill_generation_jobs (as_of_date, request_id, state) VALUES (?, ?, 'queued') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
          [input.periodKey, input.requestId]
        );
        const [rows] = await pool.query(
          'SELECT id, as_of_date, request_id FROM rental_bill_generation_jobs WHERE as_of_date = ? OR request_id = ? ORDER BY id LIMIT 1',
          [input.periodKey, input.requestId]
        );
        if (!rows.length || dateOnly(rows[0].as_of_date) !== input.periodKey || rows[0].request_id !== input.requestId) {
          throw Object.assign(new Error('BILLING_TENANT_JOB_IDEMPOTENCY_CONFLICT'), { code: 'BILLING_TENANT_JOB_IDEMPOTENCY_CONFLICT' });
        }
        return Object.freeze({ tenantId: input.tenantId, appId: input.appId, jobId: Number(rows[0].id) });
      }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodKey)) {
        throw Object.assign(new Error('RECURRING_BILLING_PERIOD_INVALID'), { code: 'RECURRING_BILLING_PERIOD_INVALID' });
      }
      await pool.query(
        "INSERT INTO property_fee_generation_jobs (billing_month, request_id, state) VALUES (?, ?, 'queued') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
        [input.periodKey, input.requestId]
      );
      const [rows] = await pool.query(
        'SELECT id, billing_month, request_id FROM property_fee_generation_jobs WHERE billing_month = ? OR request_id = ? ORDER BY id LIMIT 1',
        [input.periodKey, input.requestId]
      );
      if (!rows.length || rows[0].billing_month !== input.periodKey || rows[0].request_id !== input.requestId) {
        throw Object.assign(new Error('BILLING_TENANT_JOB_IDEMPOTENCY_CONFLICT'), { code: 'BILLING_TENANT_JOB_IDEMPOTENCY_CONFLICT' });
      }
      return Object.freeze({ tenantId: input.tenantId, appId: input.appId, jobId: Number(rows[0].id) });
    }
  });
}
module.exports = { createRecurringBillingTenantAdapter };
