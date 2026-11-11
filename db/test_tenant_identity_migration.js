'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTenantIdentity, copyTenantIdentity } = require('../server/tenant-identity-migration');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function snapshot(orgId, appId = 'rental') {
  return {
    users: [
      { id: 10, username: 'same-user', password: '$2b$hash', real_name: 'Tenant Admin', role: 'admin', mode: appId, org_id: orgId, company_id: null, created_at: '2026-01-01 00:00:00' },
      { id: 11, username: 'staff', password: '$2b$hash2', real_name: 'Staff', role: 'staff', mode: appId, org_id: orgId, company_id: null, created_at: '2026-01-01 00:00:00' }
    ],
    roles: [
      { id: 2, org_id: orgId, code: 'admin', name: 'Admin', description: '', level: 'admin', is_system: 0, created_at: '2026-01-01 00:00:00' },
      { id: 3, org_id: null, code: 'staff', name: 'Staff', description: '', level: 'staff', is_system: 1, created_at: '2026-01-01 00:00:00' },
      { id: 4, org_id: 999, code: 'other', name: 'Other', description: '', level: 'staff', is_system: 0, created_at: '2026-01-01 00:00:00' }
    ],
    settings: [{ org_id: orgId, currency: 'USD', rate: '7.2', net_price_per_mb: '1', water_price: '4.5', elec_price: '1', item_lib: null, remind_enable: 1, remind_days: 3 }],
    user_permissions: [
      { id: 1, user_id: 11, page: 'rooms' },
      { id: 2, user_id: 10, page: 'bills' }
    ],
    role_permissions: [
      { id: 1, role_id: 3, org_id: 0, page: 'rooms' },
      { id: 2, role_id: 3, org_id: orgId, page: 'dashboard' },
      { id: 3, role_id: 2, org_id: 0, page: 'dashboard' },
      { id: 4, role_id: 2, org_id: 999, page: 'secret' }
    ],
    legacySessionCount: 4
  };
}

test('normalizes tenant users, referenced roles and effective role permissions only', () => {
  const result = normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: snapshot(12) });
  assert.equal(result.tables.users.length, 2);
  assert.equal(result.tables.users[0].username, 'same-user');
  assert.equal(Object.hasOwn(result.tables.users[0], 'org_id'), false);
  assert.deepEqual(result.tables.roles.map(r => r.code).sort(), ['admin', 'staff']);
  assert.deepEqual(result.tables.role_permissions, [
    { role_id: 2, page: 'dashboard' },
    { role_id: 3, page: 'dashboard' }
  ]);
  assert.equal(result.tables.settings.length, 1);
  assert.equal(result.revokedLegacySessions, 4);
});

test('rejects user rows outside the selected tenant or product', () => {
  const wrongOrg = snapshot(12);
  wrongOrg.users[0].org_id = 13;
  assert.throws(() => normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: wrongOrg }), /TENANT_IDENTITY_MIGRATION_USER_SCOPE_INVALID/);
  const wrongProduct = snapshot(12);
  wrongProduct.users[0].mode = 'hotel';
  assert.throws(() => normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: wrongProduct }), /TENANT_IDENTITY_MIGRATION_USER_SCOPE_INVALID/);
});

test('requires referenced roles and exactly one tenant settings row', () => {
  const missingRole = snapshot(12);
  missingRole.roles = missingRole.roles.filter(r => r.code !== 'admin');
  assert.throws(() => normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: missingRole }), /TENANT_IDENTITY_MIGRATION_ROLE_MISSING/);
  const noSettings = snapshot(12);
  noSettings.settings = [];
  assert.throws(() => normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: noSettings }), /TENANT_IDENTITY_MIGRATION_SETTINGS_INVALID/);
});

test('never copies legacy session tokens and preserves duplicate usernames in separate tenant snapshots', () => {
  const first = normalizeTenantIdentity({ appId: 'rental', tenantId, sourceOrgId: 12, snapshot: snapshot(12) });
  const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const second = normalizeTenantIdentity({ appId: 'rental', tenantId: secondId, sourceOrgId: 13, snapshot: snapshot(13) });
  assert.equal(first.tables.users[0].username, second.tables.users[0].username);
  assert.equal(Object.hasOwn(first.tables, 'sessions'), false);
  assert.equal(first.revokedLegacySessions, 4);
});

test('copy mode verifies target readback and requires audit and full adapters', async () => {
  const source = snapshot(21);
  let written;
  const events = [];
  const deps = {
    appId: 'hotel', tenantId, sourceOrgId: 21,
    sourceReader: { exportTenantIdentity: async () => source },
    targetWriter: { importTenantIdentity: async ({ tables }) => { written = tables; } },
    targetReader: { readTenantIdentity: async () => ({ tables: written }) },
    audit: async event => { events.push(event.event); }
  };
  const result = await copyTenantIdentity({ ...deps, mode: 'copy' });
  assert.equal(result.copied, true);
  assert.ok(events.includes('tenant_identity_migration_copy_verified'));
  await assert.rejects(copyTenantIdentity({ ...deps, targetReader: { readTenantIdentity: async () => ({ tables: { ...written, users: [] } }) }, mode: 'copy' }), /TENANT_IDENTITY_MIGRATION_RECONCILIATION_FAILED/);
  await assert.rejects(copyTenantIdentity({ ...deps, targetWriter: undefined, mode: 'copy' }), /TENANT_IDENTITY_MIGRATION_TARGET_REQUIRED/);
  await assert.rejects(copyTenantIdentity({ ...deps, audit: undefined, mode: 'dry-run' }), /TENANT_IDENTITY_MIGRATION_AUDIT_REQUIRED/);
});
