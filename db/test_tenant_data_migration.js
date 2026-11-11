'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TABLES } = require('../server/tenant-repository');
const { copyTenantOrgData } = require('../server/tenant-data-migration');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function sourceSnapshot(appId, orgId) {
  return { tables: Object.fromEntries([...TABLES[appId]].map(table => [table, [{ id: 1, org_id: orgId, name: table }]])) };
}
function adapters(appId, orgId) {
  const calls = [];
  let stored;
  return {
    calls,
    sourceReader: { exportOrgSnapshot: async args => { calls.push(['source', args]); return sourceSnapshot(appId, orgId); } },
    targetWriter: { importTenantSnapshot: async args => { calls.push(['write', args]); stored = args.tables; } },
    targetReader: { readTenantSnapshot: async () => ({ tables: stored }) },
    audit: async event => { calls.push(['audit', event.event]); }
  };
}

test('dry-run exports only the selected org and never writes target data', async () => {
  const a = adapters('rental', 12);
  const result = await copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 12, ...a
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.copied, false);
  assert.equal(result.cutover, false);
  assert.equal(a.calls.some(call => call[0] === 'write'), false);
  assert.ok(a.calls.some(call => call[0] === 'source' && call[1].sourceOrgId === 12));
});

test('copy strips legacy org_id and verifies every product table by count and SHA-256', async () => {
  const a = adapters('hotel', 23);
  const result = await copyTenantOrgData({
    appId: 'hotel', tenantId, sourceOrgId: 23, mode: 'copy', ...a
  });
  assert.equal(result.copied, true);
  assert.equal(result.cutover, false);
  assert.ok(a.calls.some(call => call[0] === 'write'));
  assert.ok(Object.values(result.manifest).every(item => item.rowCount === 1 && /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('source export cannot smuggle rows belonging to another org', async () => {
  const a = adapters('property', 31);
  a.sourceReader.exportOrgSnapshot = async () => sourceSnapshot('property', 32);
  await assert.rejects(copyTenantOrgData({
    appId: 'property', tenantId, sourceOrgId: 31, ...a
  }), /TENANT_DATA_MIGRATION_SOURCE_SCOPE_MISMATCH/);
  assert.equal(a.calls.some(call => call[0] === 'write'), false);
});

test('copy fails closed when target reconciliation differs', async () => {
  const a = adapters('rental', 44);
  a.targetReader.readTenantSnapshot = async () => ({ tables: Object.fromEntries([...TABLES.rental].map(table => [table, []])) });
  await assert.rejects(copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 44, mode: 'copy', ...a
  }), /TENANT_DATA_MIGRATION_RECONCILIATION_FAILED/);
  assert.ok(a.calls.some(call => call[0] === 'audit' && call[1] === 'tenant_data_migration_copy_failed'));
});

test('copy requires durable audit and a complete target adapter before side effects', async () => {
  const a = adapters('rental', 55);
  await assert.rejects(copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 55, mode: 'copy',
    sourceReader: a.sourceReader, audit: a.audit
  }), /TENANT_DATA_MIGRATION_TARGET_REQUIRED/);
  await assert.rejects(copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 55,
    sourceReader: a.sourceReader
  }), /TENANT_DATA_MIGRATION_AUDIT_REQUIRED/);
  assert.equal(a.calls.some(call => call[0] === 'source'), false);
});

test('migration rejects invalid tenant identity, unsupported mode and incomplete table sets', async () => {
  const a = adapters('rental', 66);
  await assert.rejects(copyTenantOrgData({ appId: 'rental', tenantId: 'not-a-uuid', sourceOrgId: 66, ...a }), /TENANT_DATA_MIGRATION_IDENTITY_INVALID/);
  await assert.rejects(copyTenantOrgData({ appId: 'rental', tenantId, sourceOrgId: 66, mode: 'cutover', ...a }), /TENANT_DATA_MIGRATION_MODE_INVALID/);
  a.sourceReader.exportOrgSnapshot = async () => ({ tables: {} });
  await assert.rejects(copyTenantOrgData({ appId: 'rental', tenantId, sourceOrgId: 66, ...a }), /TENANT_DATA_MIGRATION_TABLE_SET_MISMATCH/);
});

test('audit failure blocks the next migration phase', async () => {
  let sourceCalled = false;
  await assert.rejects(copyTenantOrgData({
    appId: 'hotel', tenantId, sourceOrgId: 77,
    sourceReader: { exportOrgSnapshot: async () => { sourceCalled = true; return sourceSnapshot('hotel', 77); } },
    audit: async () => { throw new Error('AUDIT_UNAVAILABLE'); }
  }), /AUDIT_UNAVAILABLE/);
  assert.equal(sourceCalled, false);
});


test('migration rejects orphaned product relationships before target writes', async () => {
  const a = adapters('rental', 88);
  const snapshot = sourceSnapshot('rental', 88);
  snapshot.tables.rooms[0].building_id = 9999;
  a.sourceReader.exportOrgSnapshot = async () => snapshot;
  await assert.rejects(copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 88, mode: 'copy', ...a
  }), /TENANT_DATA_MIGRATION_RELATIONSHIP_INVALID/);
  assert.equal(a.calls.some(call => call[0] === 'write'), false);
  assert.ok(!a.calls.some(call => call[0] === 'audit' && call[1] === 'tenant_data_migration_copy_verified'));
});

test('migration accepts internally consistent room and billing relationships', async () => {
  const a = adapters('rental', 89);
  const snapshot = sourceSnapshot('rental', 89);
  snapshot.tables.rooms[0].building_id = 1;
  snapshot.tables.contracts[0].room_id = 1;
  snapshot.tables.contracts[0].tenant_id = 1;
  snapshot.tables.bills[0].room_id = 1;
  snapshot.tables.bills[0].tenant_id = 1;
  snapshot.tables.bills[0].contract_id = 1;
  snapshot.tables.meters[0].room_id = 1;
  snapshot.tables.repairs[0].room_id = 1;
  a.sourceReader.exportOrgSnapshot = async () => snapshot;
  const result = await copyTenantOrgData({
    appId: 'rental', tenantId, sourceOrgId: 89, mode: 'copy', ...a
  });
  assert.equal(result.copied, true);
});
