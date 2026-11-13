'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TenantPoolManager } = require('../server/tenant-db');

const context = overrides => ({
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  appId: 'rental',
  db: {
    host: 'db.internal', port: 3306, database: 'tenant_a',
    user: 'tenant_user', password: 'tenant-password', credentialVersion: 'v1'
  },
  ...overrides
});

test('tenant pool manager deduplicates concurrent creation for the same tenant credentials', async () => {
  let creates = 0;
  const pool = { end: async () => {}, id: 1 };
  const manager = new TenantPoolManager({ createPool: () => { creates++; return pool; } });
  const [a, b] = await Promise.all([manager.getPool(context()), manager.getPool(context())]);
  assert.equal(a, pool);
  assert.equal(b, pool);
  assert.equal(creates, 1);
  assert.equal(manager.size, 1);
  await manager.closeAll();
});

test('tenant pool manager rejects new work after closeAll and drains pending creation', async () => {
  let creates = 0;
  const manager = new TenantPoolManager({
    createPool: () => { creates++; return { end: async () => {} }; }
  });
  const pending = manager.getPool(context());
  await manager.closeAll();
  await assert.rejects(pending, /TENANT_POOL_INVALIDATED/);
  await assert.rejects(manager.getPool(context()), /TENANT_POOL_MANAGER_CLOSED/);
  assert.equal(creates, 0);
  assert.equal(manager.size, 0);
  await manager.closeAll();
});

test('tenant pool manager closes LRU pools when the configured capacity is reached', async () => {
  const closed = [];
  const manager = new TenantPoolManager({
    maxPools: 1,
    createPool: options => ({ options, end: async () => { closed.push(options.database); } })
  });
  await manager.getPool(context());
  await manager.getPool(context({
    tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    db: { ...context().db, database: 'tenant_b' }
  }));
  assert.deepEqual(closed, ['tenant_a']);
  assert.equal(manager.size, 1);
  await manager.closeAll();
  assert.deepEqual(closed, ['tenant_a', 'tenant_b']);
});

test('tenant pool manager rejects invalid tenant database identifiers before pool creation', async () => {
  let creates = 0;
  const manager = new TenantPoolManager({ createPool: () => { creates++; return { end: async () => {} }; } });
  await assert.rejects(manager.getPool(context({ db: { ...context().db, database: 'tenant-a; DROP TABLE users' } })),
    /TENANT_DATABASE_IDENTIFIER_INVALID/);
  assert.equal(creates, 0);
  await manager.closeAll();
});


test('concurrent closeAll calls share the same pool-drain completion', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new TenantPoolManager({
    createPool: () => ({ end: async () => { await gate; } })
  });
  await manager.getPool(context());
  let firstDone = false, secondDone = false;
  const first = manager.closeAll().then(() => { firstDone = true; });
  const second = manager.closeAll().then(() => { secondDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  release();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});
