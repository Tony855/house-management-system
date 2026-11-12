'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { createRecurringBillingDispatchStore } = require('../server/recurring-billing-dispatch-store');

test('recurring billing dispatch claims, lease recovery, retry backoff and terminal failure work on MariaDB', async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'platform_control_test',
    connectionLimit: 2,
    dateStrings: true
  });
  const tenantId = randomUUID();
  const store = createRecurringBillingDispatchStore(pool);
  try {
    await pool.query(
      'INSERT INTO platform_tenants (tenant_uuid, app_id, display_label, lifecycle_state, db_host, db_port, db_name, db_secret_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, 'property', 'Recurring billing CI', 'active', '127.0.0.1', 3306, 'ci_recurring_' + tenantId.replace(/-/g, ''), 'ci/recurring/' + tenantId]
    );

    const firstScan = await store.enqueueActiveTenants({ appId: 'property', periodKey: '2099-11', limit: 500 });
    assert.ok(firstScan.scanned >= 1);
    const [firstRows] = await pool.query(
      'SELECT id, request_id, state, attempt_count FROM platform_recurring_billing_dispatch WHERE tenant_uuid = ? AND job_type = ? AND period_key = ?',
      [tenantId, 'property_fee', '2099-11']
    );
    assert.equal(firstRows.length, 1);
    const firstId = Number(firstRows[0].id);

    await store.enqueueActiveTenants({ appId: 'property', periodKey: '2099-11', limit: 500 });
    const [duplicateRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM platform_recurring_billing_dispatch WHERE tenant_uuid = ? AND job_type = ? AND period_key = ?',
      [tenantId, 'property_fee', '2099-11']
    );
    assert.equal(Number(duplicateRows[0].total), 1, 'repeated scheduler scans must remain idempotent');

    const claimed = await store.claim({ id: firstId, workerId: 'ci-worker-a', leaseSeconds: 30 });
    assert.equal(claimed.workerId, 'ci-worker-a');
    assert.match(claimed.leaseToken, /^[0-9a-f-]{36}$/i);
    const oldLeaseToken = claimed.leaseToken;
    assert.equal(claimed.attemptCount, 1);
    assert.equal(await store.renewLease({ id: firstId, workerId: 'ci-worker-a', leaseToken: oldLeaseToken, leaseSeconds: 60 }), true,
      'the current lease owner must be able to extend its active claim');
    assert.equal(await store.renewLease({ id: firstId, workerId: 'ci-worker-b', leaseToken: oldLeaseToken, leaseSeconds: 60 }), false,
      'a different worker must never extend another owner lease');
    assert.equal(await store.claim({ id: firstId, workerId: 'ci-worker-b', leaseSeconds: 30 }), null,
      'a live lease must exclude a competing worker');

    await pool.query(
      'UPDATE platform_recurring_billing_dispatch SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE id = ?',
      [firstId]
    );
    const recovered = await store.claim({ id: firstId, workerId: 'ci-worker-a', leaseSeconds: 30 });
    assert.equal(recovered.workerId, 'ci-worker-a');
    assert.notEqual(recovered.leaseToken, oldLeaseToken, 'a restarted process reusing the same worker ID must receive a new fencing token');
    assert.equal(recovered.attemptCount, 2);
    assert.equal(await store.markDispatched({ id: firstId, workerId: 'ci-worker-a', leaseToken: oldLeaseToken }), false,
      'the previous process token must not complete a reclaimed job even when the worker ID is reused');
    assert.equal(await store.markDispatched({ id: firstId, workerId: 'ci-worker-a', leaseToken: recovered.leaseToken }), true);
    const [completedRows] = await pool.query(
      'SELECT state, lease_owner, lease_expires_at FROM platform_recurring_billing_dispatch WHERE id = ?',
      [firstId]
    );
    assert.equal(completedRows[0].state, 'dispatched');
    assert.equal(completedRows[0].lease_owner, null);
    assert.equal(completedRows[0].lease_expires_at, null);

    await store.enqueueActiveTenants({ appId: 'property', periodKey: '2099-12', limit: 500 });
    const [retryRows] = await pool.query(
      'SELECT id FROM platform_recurring_billing_dispatch WHERE tenant_uuid = ? AND job_type = ? AND period_key = ?',
      [tenantId, 'property_fee', '2099-12']
    );
    assert.equal(retryRows.length, 1);
    const retryId = Number(retryRows[0].id);
    await store.claim({ id: retryId, workerId: 'ci-worker-a', leaseSeconds: 30 });
    assert.equal(await store.markFailed({ id: retryId, workerId: 'ci-worker-a', leaseToken: (await pool.query('SELECT lease_token FROM platform_recurring_billing_dispatch WHERE id = ?', [retryId]))[0][0].lease_token, errorCode: 'TENANT_DB_UNAVAILABLE' }), true);
    const [retryState] = await pool.query(
      'SELECT state, error_code, available_at, attempt_count FROM platform_recurring_billing_dispatch WHERE id = ?',
      [retryId]
    );
    assert.equal(retryState[0].state, 'queued');
    assert.equal(retryState[0].error_code, 'TENANT_DB_UNAVAILABLE');
    assert.ok(retryState[0].available_at);
    assert.equal(Number(retryState[0].attempt_count), 1);

    await pool.query(
      "UPDATE platform_recurring_billing_dispatch SET available_at = UTC_TIMESTAMP(), attempt_count = 7 WHERE id = ?",
      [retryId]
    );
    const finalClaim = await store.claim({ id: retryId, workerId: 'ci-worker-a', leaseSeconds: 30 });
    assert.equal(await store.markFailed({ id: retryId, workerId: 'ci-worker-a', leaseToken: finalClaim.leaseToken, errorCode: 'TENANT_DB_UNAVAILABLE' }), true);
    const [terminalRows] = await pool.query(
      'SELECT state, attempt_count FROM platform_recurring_billing_dispatch WHERE id = ?',
      [retryId]
    );
    assert.equal(terminalRows[0].state, 'failed', 'the eighth failed attempt must become terminal');
    assert.equal(Number(terminalRows[0].attempt_count), 8);
  } finally {
    await pool.query('DELETE FROM platform_recurring_billing_dispatch WHERE tenant_uuid = ?', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM platform_tenants WHERE tenant_uuid = ?', [tenantId]).catch(() => {});
    await pool.end();
  }
});
