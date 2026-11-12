'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createPlatformBillingWorkerAuthorizer } = require('../server/platform-billing-worker-authorizer');
const enabled = Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

test('MariaDB enforces registered billing worker credential, status and exact app/job scopes', { skip: !enabled }, async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, connectionLimit: 2
  });
  const workerId = 'ci-billing-worker-identity';
  const secret = 'ci-worker-secret-32-bytes-minimum-123456';
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    await pool.execute('DELETE FROM platform_billing_worker_scopes WHERE worker_id=?', [workerId]);
    await pool.execute('DELETE FROM platform_billing_workers WHERE worker_id=?', [workerId]);
    await pool.execute("INSERT INTO platform_billing_workers (worker_id, credential_sha256, status) VALUES (?, ?, 'active')", [workerId, hash]);
    await pool.execute("INSERT INTO platform_billing_worker_scopes (worker_id, app_id, job_type) VALUES (?, 'rental', 'rental_bill')", [workerId]);
    const authorize = createPlatformBillingWorkerAuthorizer({ pool, workerId, workerSecret: secret });
    assert.equal(await authorize({ workerId, appId: 'rental', tenantId, jobType: 'rental_bill' }), true);
    assert.equal(await authorize({ workerId, appId: 'property', tenantId, jobType: 'property_fee' }), false);
    assert.equal(await authorize({ workerId: 'spoofed-worker', appId: 'rental', tenantId, jobType: 'rental_bill' }), false);
    const wrongSecret = createPlatformBillingWorkerAuthorizer({ pool, workerId, workerSecret: 'different-secret-32-bytes-minimum-123456' });
    assert.equal(await wrongSecret({ workerId, appId: 'rental', tenantId, jobType: 'rental_bill' }), false);
    await pool.execute("UPDATE platform_billing_workers SET status='disabled' WHERE worker_id=?", [workerId]);
    assert.equal(await authorize({ workerId, appId: 'rental', tenantId, jobType: 'rental_bill' }), false);
  } finally {
    await pool.execute('DELETE FROM platform_billing_worker_scopes WHERE worker_id=?', [workerId]);
    await pool.execute('DELETE FROM platform_billing_workers WHERE worker_id=?', [workerId]);
    await pool.end();
  }
});
