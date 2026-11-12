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
