'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecurringBillingTenantAdapter } = require('../server/recurring-billing-tenant-adapter');
const { createRecurringBillingRunner, localDateParts } = require('../server/recurring-billing-runner');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function adapterFixture(appId, rows) {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT id,')) return [rows, []];
    return [{ affectedRows: 1 }, []];
  }};
  const adapter = createRecurringBillingTenantAdapter({
    registry: { findTenantById: async id => ({
      tenant_uuid: id, app_id: appId, lifecycle_state: 'active',
      db_host: '127.0.0.1', db_port: 3306, db_name: 'tenant_db', db_secret_ref: 'tenant-db/' + id
    }) },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'tenant_user', password: 'secret', version: 'v1' }) },
    tenantPoolManager: { getPool: async context => { assert.equal(context.db.database, 'tenant_db'); return pool; } }
  });
  return { adapter, calls };
}

test('tenant adapter resolves active registry and secret-backed credentials before rental job enqueue', async () => {
  const { adapter, calls } = adapterFixture('rental', [{ id: 7, as_of_date: '2030-02-01', request_id: 'request-1' }]);
  const result = await adapter.enqueueTenantJob({
    tenantId, appId: 'rental', jobType: 'rental_bill', periodKey: '2030-02-01', requestId: 'request-1'
  });
  assert.deepEqual(result, { tenantId, appId: 'rental', jobId: 7 });
  assert.match(calls[0][0], /rental_bill_generation_jobs/);
});

test('tenant adapter writes property monthly jobs to the tenant-local table', async () => {
  const { adapter, calls } = adapterFixture('property', [{ id: 8, billing_month: '2030-02', request_id: 'request-2' }]);
  const result = await adapter.enqueueTenantJob({
    tenantId, appId: 'property', jobType: 'property_fee', periodKey: '2030-02', requestId: 'request-2'
  });
  assert.deepEqual(result, { tenantId, appId: 'property', jobId: 8 });
  assert.match(calls[0][0], /property_fee_generation_jobs/);
});

test('tenant adapter refuses suspended or wrong-product tenants before opening tenant pool', async () => {
  let opened = false;
  const adapter = createRecurringBillingTenantAdapter({
    registry: { findTenantById: async id => ({
      tenant_uuid: id, app_id: 'hotel', lifecycle_state: 'suspended',
      db_host: '127.0.0.1', db_port: 3306, db_name: 'tenant_db', db_secret_ref: 'secret'
    }) },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'u', password: 'p' }) },
    tenantPoolManager: { getPool: async () => { opened = true; return {}; } }
  });
  await assert.rejects(adapter.enqueueTenantJob({
    tenantId, appId: 'rental', jobType: 'rental_bill', periodKey: '2030-02-01', requestId: 'request-1'
  }), /TENANT_APP_MISMATCH/);
  assert.equal(opened, false);
});

test('runner uses tenant-local calendar date, catches up both products and pages all active tenants', async () => {
  assert.deepEqual(localDateParts(new Date('2030-03-01T17:30:00Z'), 'Asia/Phnom_Penh'), { date: '2030-03-02', month: '2030-03' });
  const scans = [];
  let dispatches = 0;
  const runner = createRecurringBillingRunner({
    store: { enqueueActiveTenants: async input => {
      scans.push(input);
      if (!input.afterTenantId) return { scanned: 2, enqueued: 2, nextCursor: tenantId };
      return { scanned: 1, enqueued: 1, nextCursor: null };
    }},
    dispatcher: { tick: async () => { dispatches++; return { scanned: 0, results: [] }; }},
    workerId: 'billing-worker', now: () => new Date('2030-03-01T17:30:00Z')
  });
  const result = await runner.tick();
  assert.equal(result.scans.length, 2);
  assert.equal(scans.length, 4);
  assert.equal(dispatches, 1);
  assert.equal(scans.find(x => x.appId === 'rental').periodKey, '2030-03-02');
  assert.equal(scans.find(x => x.appId === 'property').periodKey, '2030-03');
  await runner.stop();
});

test('tenant adapter normalizes mysql2 DATE values returned as JavaScript Date objects', async () => {
  const date = new Date(2030, 1, 1, 0, 0, 0);
  const { adapter } = adapterFixture('rental', [{ id: 17, as_of_date: date, request_id: 'request-date-object' }]);
  const result = await adapter.enqueueTenantJob({
    tenantId, appId: 'rental', jobType: 'rental_bill', periodKey: '2030-02-01', requestId: 'request-date-object'
  });
  assert.deepEqual(result, { tenantId, appId: 'rental', jobId: 17 });
});
