'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantDataMigrationExecutor } = require('../server/tenant-data-migration-executor');

test('executor resolves credentials outside job payload, uses adapters and checkpoints verified dry-run', async () => {
  const calls = [];
  const appId = 'rental';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tables = require('../server/tenant-repository').TABLES[appId];
  const sourcePool = {
    async execute() { return [[]]; },
    async getConnection() {
      return {
        async execute(sql) {
          if (sql.includes('SELECT DATABASE()')) return [[{ databaseName: 'house_sys_rental' }]];
          if (sql.includes('SELECT * FROM')) return [sql.includes('buildings') ? [{ id: 1, org_id: 7, name: 'A' }] : []];
          return [[]];
        },
        async commit() {}, async rollback() {}, release() {}
      };
    }
  };
  const targetPool = {
    async execute(sql) {
      if (sql.includes('SELECT DATABASE()')) return [[{ databaseName: 'rental_aaaaaaaaaaaaaaaaaaaaaaaa' }]];
      if (sql.includes('SELECT * FROM')) return [sql.includes('buildings') ? [{ id: 1, name: 'A' }] : []];
      return [[]];
    },
    async getConnection() { throw new Error('dry-run must not write target'); }
  };
  const execute = createTenantDataMigrationExecutor({
    resolveConnections: async scope => {
      calls.push(scope);
      return { sourcePool, targetPool, audit: async event => calls.push(event.event) };
    },
    heartbeatIntervalMs: 5000
  });
  const result = await execute({
    job: { id: 1, appId, tenantId, sourceOrgId: 7, mode: 'dry-run' },
    heartbeat: async () => calls.push('heartbeat'),
    saveCheckpoint: async value => calls.push(value.phase)
  });
  assert.equal(result.copied, false);
  assert.equal(result.cutover, false);
  assert.ok(calls.find(value => value && typeof value === 'object' && value.appId === appId).signal instanceof AbortSignal);
  assert.deepEqual(calls.filter(x => typeof x === 'string'), [
    'heartbeat', 'resolving_connections', 'copy_started',
    'tenant_data_migration_started', 'tenant_data_migration_dry_run_verified', 'heartbeat', 'verified'
  ]);
  assert.deepEqual(Object.keys(result.manifest).sort(), [...tables].sort());
});

test('executor rejects missing scoped connection resolver and closes resolved resources', async () => {
  assert.throws(() => createTenantDataMigrationExecutor(), /TENANT_MIGRATION_CONNECTION_RESOLVER_REQUIRED/);
  let closed = 0;
  const execute = createTenantDataMigrationExecutor({
    resolveConnections: async () => ({ sourcePool: {}, targetPool: {}, audit: async () => {}, close: async () => { closed++; } })
  });
  await assert.rejects(execute({
    job: { id: 1, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceOrgId: 7, mode: 'copy' },
    heartbeat: async () => {}, saveCheckpoint: async () => {}
  }), /TENANT_MIGRATION_SOURCE_POOL_REQUIRED/);
  assert.equal(closed, 1);
});


test('executor aborts connection resolution and closes late resources after lease renewal fails', async () => {
  let heartbeatCount = 0;
  let receivedSignal;
  let closed = 0;
  const execute = createTenantDataMigrationExecutor({
    heartbeatIntervalMs: 5000,
    resolveConnections: async ({ signal }) => {
      receivedSignal = signal;
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({
          sourcePool: {}, targetPool: {}, audit: async () => {},
          close: async () => { closed++; }
        }), { once: true });
      });
    }
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(execute({
      job: { id: 2, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceOrgId: 9, mode: 'dry-run' },
      heartbeat: async () => {
        heartbeatCount++;
        if (heartbeatCount > 1) throw Object.assign(new Error('lease lost'), { code: 'TENANT_MIGRATION_JOB_LEASE_LOST' });
      },
      saveCheckpoint: async () => {}
    }), error => error.code === 'TENANT_MIGRATION_JOB_LEASE_LOST');
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(closed, 1);
  } finally {
    clearInterval(keepAlive);
  }
});


test('executor preserves the primary migration error when connection cleanup also fails', async () => {
  const execute = createTenantDataMigrationExecutor({
    resolveConnections: async () => ({
      sourcePool: {}, targetPool: {}, audit: async () => {},
      close: async () => { throw Object.assign(new Error('cleanup details'), { code: 'POOL_CLOSE_FAILED' }); }
    })
  });
  await assert.rejects(execute({
    job: { id: 3, appId: 'rental', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceOrgId: 9, mode: 'copy' },
    heartbeat: async () => {}, saveCheckpoint: async () => {}
  }), error => {
    assert.equal(error.code, 'TENANT_MIGRATION_SOURCE_POOL_REQUIRED');
    assert.equal(error.cleanupError, 'POOL_CLOSE_FAILED');
    return true;
  });
});
