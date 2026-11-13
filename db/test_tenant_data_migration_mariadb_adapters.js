'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TABLES } = require('../server/tenant-repository');
const { createMariaDbTenantMigrationAdapters } = require('../server/tenant-data-migration-mariadb');
const { tenantDatabaseName } = require('../server/tenant-provisioner');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createPools(appId, sourceOrgId, { lockAcquired = true, releaseLockSucceeds = true, failInsertTable = null } = {}) {
  const sourceCalls = [];
  const targetCalls = [];
  const sourceTables = Object.fromEntries([...TABLES[appId]].map(table => [table, [
    { id: 1, org_id: sourceOrgId, name: table },
    { id: 2, org_id: sourceOrgId + 1, name: 'other-org-' + table }
  ]]));
  const targetTables = Object.fromEntries([...TABLES[appId]].map(table => [table, []]));
  let committed = false;
  let rolledBack = false;
  let destroyed = false;
  const targetDatabase = tenantDatabaseName(appId, tenantId);
  const sourcePool = {
    async execute(sql, params) {
      sourceCalls.push({ sql, params });
      if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: 'house_sys_' + appId }]];
      const table = sql.match(/FROM `([a-z_]+)`/i)?.[1];
      return [sourceTables[table].filter(row => row.org_id === params[0]).map(row => ({ ...row }))];
    },
    async getConnection() {
      return {
        async execute(sql, params) {
          sourceCalls.push({ sql, params });
          if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: 'house_sys_' + appId }]];
          if (!sql.startsWith('SELECT *')) return [[], []];
          const table = sql.match(/FROM `([a-z_]+)`/i)?.[1];
          return [sourceTables[table].filter(row => row.org_id === params[0]).map(row => ({ ...row }))];
        },
        async commit() { sourceCalls.push({ sql: 'COMMIT' }); },
        async rollback() { sourceCalls.push({ sql: 'ROLLBACK' }); },
        release() { sourceCalls.push({ sql: 'RELEASE_SOURCE' }); }
      };
    }
  };
  const targetPool = {
    async execute(sql) {
      if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: targetDatabase }]];
      const table = sql.match(/FROM `([a-z_]+)`/i)?.[1];
      if (sql.startsWith('SELECT *')) return [targetTables[table].map(row => ({ ...row }))];
      throw new Error('UNEXPECTED_TARGET_QUERY');
    },
    async getConnection() {
      const snapshot = structuredClone(targetTables);
      return {
        async beginTransaction() { targetCalls.push('BEGIN'); },
        async execute(sql, params = []) {
          targetCalls.push(sql);
          if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: targetDatabase }]];
          if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: lockAcquired ? 1 : 0 }]];
          if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: releaseLockSucceeds ? 1 : 0 }]];
          const countTable = sql.match(/SELECT COUNT\(\*\) AS total FROM `([a-z_]+)`/i)?.[1];
          if (countTable) return [[{ total: targetTables[countTable].length }]];
          const insertMatch = sql.match(/INSERT INTO `([a-z_]+)` \(([^)]+)\) VALUES/i);
          if (insertMatch) {
            const table = insertMatch[1];
            if (table === failInsertTable) throw new Error('INJECTED_INSERT_FAILURE');
            const columns = [...insertMatch[2].matchAll(/`([a-z_]+)`/gi)].map(match => match[1]);
            const width = columns.length;
            for (let i = 0; i < params.length; i += width) {
              targetTables[table].push(Object.fromEntries(columns.map((column, index) => [column, params[i + index]])));
            }
            return [{ affectedRows: params.length / width }];
          }
          throw new Error('UNEXPECTED_TARGET_TRANSACTION_QUERY');
        },
        async commit() { committed = true; targetCalls.push('COMMIT'); },
        async rollback() {
          rolledBack = true;
          for (const table of Object.keys(snapshot)) targetTables[table] = snapshot[table];
          targetCalls.push('ROLLBACK');
        },
        release() { targetCalls.push('RELEASE'); },
        destroy() { destroyed = true; targetCalls.push('DESTROY'); }
      };
    }
  };
  return { sourcePool, targetPool, sourceCalls, targetCalls, sourceTables, targetTables, get committed() { return committed; }, get rolledBack() { return rolledBack; }, get destroyed() { return destroyed; } };
}

test('MariaDB source adapter scopes every query to the selected org with bound parameters', async () => {
  const f = createPools('rental', 17);
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  const snapshot = await adapters.sourceReader.exportOrgSnapshot({ appId: 'rental', sourceOrgId: 17 });
  assert.deepEqual(Object.keys(snapshot.tables).sort(), [...TABLES.rental].sort());
  assert.equal(f.sourceCalls.filter(call => call.sql.startsWith('SELECT *')).length, TABLES.rental.size);
  assert.ok(f.sourceCalls.some(call => call.sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'));
  assert.ok(f.sourceCalls.some(call => call.sql === 'COMMIT'));
  assert.ok(f.sourceCalls.some(call => call.sql === 'RELEASE_SOURCE'));
  assert.ok(snapshot.tables.buildings.every(row => row.org_id === 17));
  assert.equal(snapshot.tables.buildings.length, 1);
  assert.ok(f.sourceCalls.filter(call => call.sql.startsWith('SELECT *')).every(call => call.sql.includes('WHERE `org_id` = ? ORDER BY `id` ASC') && call.params[0] === 17));
  await assert.rejects(adapters.sourceReader.exportOrgSnapshot({ appId: 'hotel', sourceOrgId: 17 }), /TENANT_DATA_MIGRATION_SOURCE_SCOPE_INVALID/);
});

test('MariaDB target adapter imports in one transaction without org_id and supports read-back', async () => {
  const f = createPools('hotel', 21);
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'hotel', ...f });
  const snapshot = await adapters.sourceReader.exportOrgSnapshot({ appId: 'hotel', sourceOrgId: 21 });
  const clean = Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [
    table, rows.map(({ org_id, ...row }) => row)
  ]));
  const result = await adapters.targetWriter.importTenantSnapshot({ appId: 'hotel', tenantId, tables: clean });
  const readBack = await adapters.targetReader.readTenantSnapshot({ appId: 'hotel', tenantId });
  assert.equal(result.imported, true);
  assert.equal(f.committed, true);
  assert.equal(f.rolledBack, false);
  assert.ok(f.targetCalls.some(call => call.startsWith('SELECT GET_LOCK')) && f.targetCalls.includes('BEGIN') && f.targetCalls.includes('COMMIT') && f.targetCalls.some(call => call.startsWith('SELECT RELEASE_LOCK')) && f.targetCalls.at(-1) === 'RELEASE');
  assert.ok(Object.values(readBack.tables).every(rows => rows.length === 1 && !Object.hasOwn(rows[0], 'org_id')));
});

test('MariaDB target adapter refuses a non-empty target and rolls back', async () => {
  const f = createPools('property', 33);
  f.targetTables.rooms.push({ id: 99, room_no: 'existing' });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'property', ...f });
  const tables = Object.fromEntries([...TABLES.property].map(table => [table, []]));
  await assert.rejects(adapters.targetWriter.importTenantSnapshot({ appId: 'property', tenantId, tables }), /TENANT_DATA_MIGRATION_TARGET_NOT_EMPTY/);
  assert.equal(f.committed, false);
  assert.equal(f.rolledBack, true);
  assert.equal(f.targetTables.rooms.length, 1);
});

test('MariaDB target adapter rolls back malformed snapshots and rejects org_id injection', async () => {
  const f = createPools('rental', 41);
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  const tables = Object.fromEntries([...TABLES.rental].map(table => [table, []]));
  tables.buildings = [{ id: 1, org_id: 41, name: 'bad' }];
  await assert.rejects(adapters.targetWriter.importTenantSnapshot({ appId: 'rental', tenantId, tables }), /TENANT_DATA_MIGRATION_TARGET_COLUMNS_INVALID/);
  assert.equal(f.committed, false);
  assert.equal(f.rolledBack, true);
  assert.equal(Object.values(f.targetTables).every(rows => rows.length === 0), true);
});

test('MariaDB adapters require a valid product and real mysql2-compatible pools', () => {
  assert.throws(() => createMariaDbTenantMigrationAdapters({ appId: 'platform', sourcePool: {}, targetPool: {} }), /TENANT_DATA_MIGRATION_APP_INVALID/);
  assert.throws(() => createMariaDbTenantMigrationAdapters({ appId: 'rental', sourcePool: {}, targetPool: {} }), /TENANT_MIGRATION_SOURCE_POOL_REQUIRED/);
});


test('MariaDB target adapter fails closed when the tenant advisory lock is unavailable', async () => {
  const f = createPools('rental', 51, { lockAcquired: false });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  const tables = Object.fromEntries([...TABLES.rental].map(table => [table, []]));
  await assert.rejects(
    adapters.targetWriter.importTenantSnapshot({ appId: 'rental', tenantId, tables }),
    /TENANT_DATA_MIGRATION_LOCK_UNAVAILABLE/
  );
  assert.equal(f.committed, false);
  assert.ok(!f.targetCalls.includes('BEGIN'));
  assert.ok(f.targetCalls.at(-1) === 'RELEASE');
});


test('MariaDB target adapter destroys a pooled connection if advisory lock release is not confirmed', async () => {
  const f = createPools('hotel', 61, { releaseLockSucceeds: false });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'hotel', ...f });
  const tables = Object.fromEntries([...TABLES.hotel].map(table => [table, []]));
  await adapters.targetWriter.importTenantSnapshot({ appId: 'hotel', tenantId, tables });
  assert.equal(f.committed, true);
  assert.equal(f.destroyed, true);
  assert.equal(f.targetCalls.at(-1), 'DESTROY');
  assert.ok(!f.targetCalls.includes('RELEASE'));
});


test('MariaDB adapters reject a source pool connected to the wrong product database', async () => {
  const f = createPools('rental', 71);
  f.sourcePool.getConnection = async () => ({
    async execute(sql) {
      if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: 'house_sys_property' }]];
      return [[]];
    },
    async rollback() {}, release() {}
  });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  await assert.rejects(
    adapters.sourceReader.exportOrgSnapshot({ appId: 'rental', sourceOrgId: 71 }),
    /TENANT_DATA_MIGRATION_SOURCE_DATABASE_MISMATCH/
  );
});

test('MariaDB adapters reject a tenant target pool connected to another tenant database', async () => {
  const f = createPools('rental', 81);
  f.targetPool.getConnection = async () => ({
    async execute(sql) {
      if (sql === 'SELECT DATABASE() AS databaseName') return [[{ databaseName: 'rental_othertenant' }]];
      return [[{ acquired: 1 }]];
    },
    async rollback() {}, release() {}
  });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  const tables = Object.fromEntries([...TABLES.rental].map(table => [table, []]));
  await assert.rejects(
    adapters.targetWriter.importTenantSnapshot({ appId: 'rental', tenantId, tables }),
    /TENANT_DATA_MIGRATION_TARGET_DATABASE_MISMATCH/
  );
});


test('MariaDB target adapter rolls back earlier table inserts after a later table batch fails', async () => {
  const f = createPools('rental', 91, { failInsertTable: 'bills' });
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', ...f });
  const tables = Object.fromEntries([...TABLES.rental].map(table => [table, []]));
  tables.buildings = [{ id: 10, name: 'fixture' }];
  tables.bills = [{ id: 20, amount: 12 }];
  await assert.rejects(
    adapters.targetWriter.importTenantSnapshot({ appId: 'rental', tenantId, tables }),
    /INJECTED_INSERT_FAILURE/
  );
  assert.equal(f.rolledBack, true);
  assert.equal(f.committed, false);
  assert.equal(Object.values(f.targetTables).every(rows => rows.length === 0), true);
});


test('source snapshot export aborts between table reads when the migration lease is lost', async () => {
  const pools = createPools('rental', 12);
  const adapters = createMariaDbTenantMigrationAdapters({ appId: 'rental', sourcePool: pools.sourcePool, targetPool: pools.targetPool });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapters.sourceReader.exportOrgSnapshot({ appId: 'rental', sourceOrgId: 12, signal: controller.signal }),
    error => error.code === 'TENANT_MIGRATION_JOB_LEASE_LOST');
  assert.ok(pools.sourceCalls.some(call => call.sql === 'ROLLBACK'));
});
