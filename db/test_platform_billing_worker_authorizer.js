'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { createPlatformBillingWorkerAuthorizer } = require('../server/platform-billing-worker-authorizer');

const workerId = 'platform-billing-prod-01';
const secret = 'production-worker-secret-at-least-32-bytes';

test('platform worker authorizer checks registered active credential and exact product/job scope', async () => {
  const calls = [];
  const authorizer = createPlatformBillingWorkerAuthorizer({
    pool: { execute: async (sql, params) => { calls.push({ sql, params }); return [[{ worker_id: workerId }], []]; } },
    workerId, workerSecret: secret
  });
  assert.equal(await authorizer({ workerId, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jobType: 'rental_bill' }), true);
  assert.deepEqual(calls[0].params, [
    workerId, crypto.createHash('sha256').update(secret).digest('hex'), 'rental', 'rental_bill'
  ]);
  assert.match(calls[0].sql, /w\.status = 'active'/);
});

test('platform worker authorizer rejects identity substitution and cross-product scope', async () => {
  let queried = false;
  const authorizer = createPlatformBillingWorkerAuthorizer({
    pool: { execute: async () => { queried = true; return [[{ worker_id: workerId }], []]; } },
    workerId, workerSecret: secret
  });
  assert.equal(await authorizer({ workerId: 'forged-worker', appId: 'rental', tenantId: 'x', jobType: 'rental_bill' }), false);
  assert.equal(await authorizer({ workerId, appId: 'hotel', tenantId: 'x', jobType: 'hotel_bill' }), false);
  assert.equal(queried, false);
});

test('platform worker authorizer fails closed when worker is disabled or credential/scope does not match', async () => {
  const authorizer = createPlatformBillingWorkerAuthorizer({
    pool: { execute: async () => [[], []] }, workerId, workerSecret: secret
  });
  assert.equal(await authorizer({ workerId, appId: 'property', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jobType: 'property_fee' }), false);
});

test('platform worker authorizer requires strong deployment credentials', () => {
  assert.throws(() => createPlatformBillingWorkerAuthorizer({ pool: { execute() {} }, workerId, workerSecret: 'short' }), /PLATFORM_BILLING_WORKER_SECRET_REQUIRED/);
  assert.throws(() => createPlatformBillingWorkerAuthorizer({ pool: { execute() {} }, workerSecret: secret }), /PLATFORM_BILLING_WORKER_ID_REQUIRED/);
});
