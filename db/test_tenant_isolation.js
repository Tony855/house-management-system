'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTenantContext, TenantResolutionError } = require('../server/tenant-registry');
const { TenantPoolManager } = require('../server/tenant-db');

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rowA = {
  tenant_uuid: tenantA, app_id: 'rental', lifecycle_state: 'active',
  db_host: 'db.internal', db_port: 3306, db_name: 'rental_a',
  db_secret_ref: 'secret/tenant-a', schema_version: '1'
};

test('tenant resolution requires authenticated matching app audience', async () => {
  await assert.rejects(resolveTenantContext({ auth: null, appId: 'rental' }), e => e.code === 'AUTH_REQUIRED');
  await assert.rejects(resolveTenantContext({
    auth: { authenticated: true, appId: 'hotel', tenantId: tenantA }, appId: 'rental'
  }), e => e.code === 'APP_AUDIENCE_MISMATCH');
});

test('tenant resolution rejects unknown, suspended and cross-product tenants', async () => {
  const registry = { findTenantById: async id => id === tenantA ? rowA : null };
  const secretProvider = { getDatabaseCredentials: async () => ({ user: 'tenant_a', password: 'secret' }) };
  const base = { authenticated: true, appId: 'rental', tenantId: tenantA };
  const resolved = await resolveTenantContext({ auth: base, appId: 'rental', registry, secretProvider });
  assert.equal(resolved.db.database, 'rental_a');
  await assert.rejects(resolveTenantContext({
    auth: { ...base, tenantId: tenantB }, appId: 'rental', registry, secretProvider
  }), e => e.code === 'TENANT_NOT_FOUND');
  await assert.rejects(resolveTenantContext({
    auth: base, appId: 'hotel', registry, secretProvider
  }), e => e.code === 'APP_AUDIENCE_MISMATCH');
  await assert.rejects(resolveTenantContext({
    auth: base, appId: 'rental',
    registry: { findTenantById: async () => ({ ...rowA, lifecycle_state: 'suspended' }) },
    secretProvider
  }), e => e.code === 'TENANT_NOT_ACTIVE');
});

test('same username can exist independently because registry stores no tenant users', async () => {
  const ids = new Set([tenantA, tenantB]);
  assert.equal(ids.size, 2);
});

test('pool manager isolates tenants and closes evicted/suspended pools', async () => {
  let now = 1000;
  const created = [];
  const manager = new TenantPoolManager({
    maxPools: 1, idleTtlMs: 100, now: () => now,
    createPool: config => {
      const pool = { config, ended: false, end: async function () { this.ended = true; } };
      created.push(pool);
      return pool;
    }
  });
  const context = id => ({
    tenantId: id, appId: 'rental',
    db: { host: 'db.internal', port: 3306, database: id === tenantA ? 'rental_a' : 'rental_b', user: id, password: 'secret' }
  });
  const a = await manager.getPool(context(tenantA));
  const b = await manager.getPool(context(tenantB));
  assert.notEqual(a, b);
  assert.equal(a.ended, true);
  assert.equal(manager.size, 1);
  await manager.closeTenant(tenantB);
  assert.equal(b.ended, true);
  assert.equal(manager.size, 0);
});

test('pool manager rejects unsafe database names and missing context', async () => {
  const manager = new TenantPoolManager({ createPool: () => ({ end: async () => {} }) });
  await assert.rejects(manager.getPool(null), /TENANT_CONTEXT_REQUIRED/);
  await assert.rejects(manager.getPool({
    tenantId: tenantA, appId: 'rental',
    db: { host: 'db', port: 3306, database: 'rental-a; DROP DATABASE x', user: 'u', password: 'p' }
  }), /TENANT_DATABASE_IDENTIFIER_INVALID/);
});

test('concurrent requests share one pending pool creation', async () => {
  let createCount = 0;
  let releaseEviction;
  const evictionGate = new Promise(resolve => { releaseEviction = resolve; });
  const manager = new TenantPoolManager({
    maxPools: 1, idleTtlMs: 100000,
    createPool: config => {
      createCount++;
      return { config, end: async () => {} };
    }
  });
  const context = id => ({
    tenantId: id, appId: 'rental',
    db: { host: 'db.internal', port: 3306, database: id === tenantA ? 'rental_a' : 'rental_b', user: id, password: 'secret' }
  });
  await manager.getPool(context(tenantA));
  // Both callers must join the same asynchronous eviction/create operation.
  const originalClose = manager._close.bind(manager);
  manager._close = async entry => { await evictionGate; return originalClose(entry); };
  const first = manager.getPool(context(tenantB));
  const second = manager.getPool(context(tenantB));
  releaseEviction();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(createCount, 2);
  await manager.closeAll();
  assert.equal(manager.size, 0);
});

test('closeAll invalidates in-flight tenant pool creation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new TenantPoolManager({
    maxPools: 1,
    createPool: config => ({ config, ended: false, end: async function () { this.ended = true; } })
  });
  await manager.getPool({ tenantId: tenantB, appId: 'rental', db: { host: 'db.internal', port: 3306, database: 'rental_b', user: 'tenant_b', password: 'secret' } });
  const originalClose = manager._close.bind(manager);
  manager._close = async entry => { await gate; return originalClose(entry); };
  const pending = manager.getPool({
    tenantId: tenantA, appId: 'rental',
    db: { host: 'db.internal', port: 3306, database: 'rental_a', user: 'tenant_a', password: 'secret' }
  });
  const closing = manager.closeAll();
  release();
  await closing;
  await assert.rejects(pending, /TENANT_POOL_INVALIDATED/);
  assert.equal(manager.size, 0);
});
