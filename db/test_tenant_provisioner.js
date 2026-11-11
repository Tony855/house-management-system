'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { tenantDatabaseName, tenantDatabaseUser, provisionTenant } = require('../server/tenant-provisioner');

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('database and principal names are deterministic and tenant-scoped', () => {
  assert.equal(tenantDatabaseName('rental', id), 'rental_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(tenantDatabaseUser(id), 't_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.throws(() => tenantDatabaseName('super', id), /TENANT_PROVISIONING_INPUT_INVALID/);
});

test('tenant is activated only after database grants, migrations and isolation verification', async () => {
  const calls = [];
  const adapters = {
    registry: {
      createProvisioningTenant: async row => calls.push(['create', row.lifecycle_state]),
      activateTenant: async () => calls.push(['activate']),
      markProvisioningFailed: async () => calls.push(['failed'])
    },
    databaseAdmin: {
      host: 'db.internal', port: 3306,
      createDatabase: async () => calls.push(['database']),
      createPrincipal: async () => calls.push(['principal']),
      grantDatabaseOnly: async () => calls.push(['grant'])
    },
    secretStore: { put: async () => calls.push(['secret']) },
    migrationRunner: { apply: async () => calls.push(['migrate']) },
    isolationVerifier: { verify: async () => { calls.push(['verify']); return { passed: true, schemaVersion: 'v1' }; } }
  };
  const result = await provisionTenant({ appId: 'hotel', displayLabel: 'Hotel A', tenantId: id, ...adapters });
  assert.equal(result.lifecycleState, 'active');
  assert.deepEqual(calls.map(x => x[0]), ['create', 'database', 'principal', 'grant', 'secret', 'migrate', 'verify', 'activate']);
});

test('failed isolation verification never activates tenant', async () => {
  let activated = false, failed = false;
  await assert.rejects(provisionTenant({
    appId: 'property', displayLabel: 'Property B', tenantId: id,
    registry: {
      createProvisioningTenant: async () => {},
      activateTenant: async () => { activated = true; },
      markProvisioningFailed: async () => { failed = true; }
    },
    databaseAdmin: {
      host: 'db.internal', createDatabase: async () => {}, createPrincipal: async () => {},
      grantDatabaseOnly: async () => {}
    },
    secretStore: { put: async () => {} },
    migrationRunner: { apply: async () => {} },
    isolationVerifier: { verify: async () => ({ passed: false }) }
  }), /TENANT_ISOLATION_VERIFICATION_FAILED/);
  assert.equal(activated, false);
  assert.equal(failed, true);
});
