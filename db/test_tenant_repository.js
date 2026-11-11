'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantRepository } = require('../server/tenant-repository');

function fakePool() {
  const calls = [];
  const pool = {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT COUNT')) return [[{ total: 2 }]];
      if (sql.startsWith('SELECT')) return [[{ id: 1, name: 'tenant-local' }]];
      return [{ insertId: 7, affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
        async commit() { calls.push({ sql: 'COMMIT' }); },
        async rollback() { calls.push({ sql: 'ROLLBACK' }); },
        async execute(sql, params) { return pool.execute(sql, params); },
        release() { calls.push({ sql: 'RELEASE' }); }
      };
    }
  };
  return pool;
}

test('tenant repository restricts tables to the fixed product manifest', async () => {
  const pool = fakePool();
  const repo = createTenantRepository({ pool, appId: 'rental' });
  await assert.rejects(repo.list('platform_tenants'), /TENANT_TABLE_NOT_ALLOWED/);
  await assert.rejects(repo.list('orders'), /TENANT_TABLE_NOT_ALLOWED/);
  assert.equal(pool.calls.length, 0);
});

test('tenant repository parameterizes filters and pagination on the supplied tenant pool', async () => {
  const pool = fakePool();
  const repo = createTenantRepository({ pool, appId: 'rental' });
  const rows = await repo.list('rooms', { filters: { status: "vacant' OR 1=1 --" }, limit: 10, offset: 5 });
  assert.equal(rows[0].name, 'tenant-local');
  assert.match(pool.calls[0].sql, /FROM `rooms` WHERE `status` = \? ORDER BY `id` ASC LIMIT \? OFFSET \?/);
  assert.deepEqual(pool.calls[0].params, ["vacant' OR 1=1 --", 10, 5]);
});

test('tenant repository validates identifiers, pagination and immutable primary keys', async () => {
  const repo = createTenantRepository({ pool: fakePool(), appId: 'hotel' });
  await assert.rejects(repo.list('rooms', { orderBy: 'id; DROP TABLE rooms' }), /TENANT_SQL_IDENTIFIER_INVALID/);
  await assert.rejects(repo.list('rooms', { limit: 101 }), /TENANT_PAGINATION_INVALID/);
  await assert.rejects(repo.updateById('rooms', 1, { id: 2 }), /TENANT_PRIMARY_KEY_IMMUTABLE/);
  await assert.rejects(repo.insert('rooms', { 'name) VALUES (1);--': 'x' }), /TENANT_FIELDS_INVALID/);
});

test('tenant repository transaction commits and rolls back through the same tenant connection', async () => {
  const pool = fakePool();
  const repo = createTenantRepository({ pool, appId: 'property' });
  const value = await repo.withTransaction(async tx => {
    await tx.insert('complaints', { title: 'Leak' });
    return 'saved';
  });
  assert.equal(value, 'saved');
  assert.deepEqual(pool.calls.map(call => call.sql), ['BEGIN', 'INSERT INTO `complaints` (`title`) VALUES (?)', 'COMMIT', 'RELEASE']);

  await assert.rejects(repo.withTransaction(async tx => {
    await tx.insert('complaints', { title: 'Broken' });
    throw new Error('abort');
  }), /abort/);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('tenant repository fails closed for invalid app and missing pool', () => {
  assert.throws(() => createTenantRepository({ pool: fakePool(), appId: 'platform' }), /TENANT_REPOSITORY_APP_INVALID/);
  assert.throws(() => createTenantRepository({ pool: {}, appId: 'rental' }), /TENANT_REPOSITORY_POOL_REQUIRED/);
});
