'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { tenantDatabaseName, tenantDatabaseUser, provisionTenant } = require('../server/tenant-provisioner');

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('database and principal names are deterministic and tenant-scoped', () => {
  assert.equal(tenantDatabaseName('rental', id), 'rental_aaaaaaaaaaaa4aaa8aaaaaaa');
  assert.equal(tenantDatabaseUser(id), 't_aaaaaaaaaaaa4aaa8aaaaaaa');
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
    isolationVerifier: { verify: async () => { calls.push(['verify']); return { passed: true, schemaVersion: 'v1' }; } },
    audit: async event => calls.push(['audit', event.event])
  };
  const result = await provisionTenant({ appId: 'hotel', displayLabel: 'Hotel A', tenantId: id, ...adapters });
  assert.equal(result.lifecycleState, 'active');
  assert.deepEqual(calls.map(x => x[0]), ['create', 'audit', 'database', 'principal', 'grant', 'secret', 'migrate', 'verify', 'audit', 'activate']);
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
    isolationVerifier: { verify: async () => ({ passed: false }) },
    audit: async () => {}
  }), /TENANT_ISOLATION_VERIFICATION_FAILED/);
  assert.equal(activated, false);
  assert.equal(failed, true);
});


test('partial provisioning failure removes secret, principal and database in reverse order', async () => {
  const calls = [];
  let state = '';
  await assert.rejects(provisionTenant({
    appId: 'rental', displayLabel: 'Rental C', tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    registry: {
      createProvisioningTenant: async () => calls.push('registry:create'),
      activateTenant: async () => calls.push('registry:activate'),
      markProvisioningFailed: async () => { state = 'provisioning_failed'; calls.push('registry:failed'); }
    },
    databaseAdmin: {
      host: 'db.internal',
      createDatabase: async () => calls.push('db:create'),
      createPrincipal: async () => calls.push('user:create'),
      grantDatabaseOnly: async () => { calls.push('grant'); throw new Error('GRANT_FAILED'); },
      dropPrincipal: async () => calls.push('user:drop'),
      dropDatabase: async () => calls.push('db:drop')
    },
    secretStore: {
      put: async () => calls.push('secret:put'),
      delete: async () => calls.push('secret:delete')
    },
    migrationRunner: { apply: async () => calls.push('migrate') },
    isolationVerifier: { verify: async () => ({ passed: true }) },
    audit: async () => {}
  }), /GRANT_FAILED/);
  assert.equal(state, 'provisioning_failed');
  assert.deepEqual(calls, [
    'registry:create', 'db:create', 'user:create', 'grant',
    'user:drop', 'db:drop', 'registry:failed'
  ]);
});

test('failed cleanup is surfaced without activating tenant or masking original error', async () => {
  let failedState = false;
  let auditFailure = null;
  await assert.rejects(provisionTenant({
    appId: 'hotel', displayLabel: 'Hotel C', tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    registry: {
      createProvisioningTenant: async () => {},
      activateTenant: async () => { throw new Error('SHOULD_NOT_ACTIVATE'); },
      markProvisioningFailed: async () => { failedState = true; }
    },
    databaseAdmin: {
      host: 'db.internal',
      createDatabase: async () => {},
      createPrincipal: async () => {},
      grantDatabaseOnly: async () => {},
      dropPrincipal: async () => { throw new Error('cleanup error'); },
      dropDatabase: async () => {}
    },
    secretStore: { put: async () => {}, delete: async () => {} },
    migrationRunner: { apply: async () => {} },
    isolationVerifier: { verify: async () => ({ passed: false }) },
    audit: async event => { if (event.event === 'provisioning_failed') auditFailure = event; }
  }), error => {
    assert.equal(error.message, 'TENANT_ISOLATION_VERIFICATION_FAILED');
    assert.deepEqual(error.cleanupFailures, ['principal']);
    return true;
  });
  assert.equal(failedState, true);
  assert.deepEqual(auditFailure.cleanupFailures, ['principal']);
});

test('audit persistence failure prevents activation and reports failure-audit outage', async () => {
  let activated = false;
  let failed = false;
  let dbDropped = false;
  await assert.rejects(provisionTenant({
    appId: 'rental', displayLabel: 'Audit guarded', tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    registry: {
      createProvisioningTenant: async () => {},
      activateTenant: async () => { activated = true; },
      markProvisioningFailed: async () => { failed = true; }
    },
    databaseAdmin: {
      host: 'db.internal',
      createDatabase: async () => {},
      createPrincipal: async () => {},
      grantDatabaseOnly: async () => {},
      dropPrincipal: async () => {},
      dropDatabase: async () => { dbDropped = true; }
    },
    secretStore: { put: async () => {}, delete: async () => {} },
    migrationRunner: { apply: async () => {} },
    isolationVerifier: { verify: async () => ({ passed: true, schemaVersion: 'v1' }) },
    audit: async event => {
      if (event.event === 'provisioning_verified') throw new Error('AUDIT_DB_UNAVAILABLE');
      if (event.event === 'provisioning_failed') throw new Error('AUDIT_DB_UNAVAILABLE');
    }
  }), error => {
    assert.match(error.message, /AUDIT_DB_UNAVAILABLE/);
    assert.equal(error.auditFailure, 'AUDIT_DB_UNAVAILABLE');
    assert.ok(error.cleanupFailures.includes('audit'));
    return true;
  });
  assert.equal(activated, false);
  assert.equal(failed, true);
  assert.equal(dbDropped, true);
});

test('resource creation timeout still triggers deterministic cleanup attempt', async () => {
  let dropAttempted = false;
  await assert.rejects(provisionTenant({
    appId: 'hotel', displayLabel: 'Timeout cleanup', tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    registry: {
      createProvisioningTenant: async () => {},
      activateTenant: async () => { throw new Error('must not activate'); },
      markProvisioningFailed: async () => {}
    },
    databaseAdmin: {
      host: 'db.internal',
      createDatabase: async () => { throw new Error('REMOTE_CREATED_BUT_CLIENT_TIMED_OUT'); },
      dropDatabase: async () => { dropAttempted = true; }
    },
    secretStore: { put: async () => {} },
    migrationRunner: { apply: async () => {} },
    isolationVerifier: { verify: async () => ({ passed: true }) },
    audit: async () => {}
  }), /REMOTE_CREATED_BUT_CLIENT_TIMED_OUT/);
  assert.equal(dropAttempted, true);
});
