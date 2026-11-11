'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMariaDbTenantWriteIdempotencyStore } = require('../server/tenant-write-idempotency-mariadb');

const input = {
  appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'user-1', requestId: 'request-identifier-0001',
  requestFingerprint: 'a'.repeat(64)
};
function fakeTx() {
  let record = null;
  return {
    async execute(sql, params) {
      if (sql.startsWith('INSERT IGNORE')) {
        if (!record) record = { request_fingerprint: params[4], state: 'processing', response_json: null };
        return [{ affectedRows: record ? 1 : 0 }];
      }
      if (sql.startsWith('SELECT request_fingerprint')) return [[...(record ? [{ ...record }] : [])]];
      if (sql.startsWith('UPDATE tenant_write_idempotency')) {
        if (!record || record.state !== 'processing' || record.request_fingerprint !== params[5]) return [{ affectedRows: 0 }];
        record.state = 'completed'; record.response_json = params[0]; return [{ affectedRows: 1 }];
      }
      throw new Error('UNEXPECTED_SQL');
    },
    get record() { return record; }
  };
}

test('MariaDB idempotency adapter stores result and replays without repeating mutation', async () => {
  const store = createMariaDbTenantWriteIdempotencyStore();
  const tx = fakeTx();
  let calls = 0;
  const first = await store.execute(tx, input, async () => { calls++; return { id: 77, ok: true }; });
  const second = await store.execute(tx, input, async () => { calls++; return { id: 88 }; });
  assert.deepEqual(first, { status: 'executed', result: { id: 77, ok: true } });
  assert.deepEqual(second, { status: 'replayed', result: { id: 77, ok: true } });
  assert.equal(calls, 1);
  assert.equal(tx.record.state, 'completed');
});

test('MariaDB idempotency adapter rejects changed payload fingerprint', async () => {
  const store = createMariaDbTenantWriteIdempotencyStore();
  const tx = fakeTx();
  await store.execute(tx, input, async () => ({ id: 1 }));
  const result = await store.execute(tx, { ...input, requestFingerprint: 'b'.repeat(64) }, async () => ({ id: 2 }));
  assert.deepEqual(result, { status: 'conflict' });
});

test('MariaDB idempotency adapter rolls back reservation by propagating mutation failure', async () => {
  const store = createMariaDbTenantWriteIdempotencyStore();
  const tx = fakeTx();
  await assert.rejects(store.execute(tx, input, async () => { throw new Error('DOMAIN_WRITE_FAILED'); }), /DOMAIN_WRITE_FAILED/);
  assert.equal(tx.record.state, 'processing');
});

test('MariaDB idempotency adapter requires transaction-bound SQL and validated identity', async () => {
  const store = createMariaDbTenantWriteIdempotencyStore();
  await assert.rejects(store.execute({}, input, async () => ({})), /TENANT_WRITE_TRANSACTION_EXECUTE_REQUIRED/);
  await assert.rejects(store.execute({ execute: async () => [[]] }, { ...input, appId: 'platform' }, async () => ({})), /TENANT_WRITE_IDEMPOTENCY_INPUT_INVALID/);
});
