'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMariaDbTenantDatabaseAdmin,
  createTenantProvisioningSecretStore,
  createTenantProvisioningMigrationRunner,
  createTenantProvisioningIsolationVerifier,
  createPlatformTenantProvisioningAdapters
} = require('../server/tenant-provisioning-adapters');

test('MariaDB tenant database admin scopes grants to one generated database and safely cleans up', async () => {
  const calls = [];
  const admin = createMariaDbTenantDatabaseAdmin({
    host: 'db.internal', user: 'provisioner', password: 'admin-secret',
    createConnection: async config => ({
      query: async (sql, values) => { calls.push({ config, sql, values }); return [{ affectedRows: 1 }, []]; },
      end: async () => calls.push({ end: true })
    })
  });
  await admin.createDatabase('rental_123456781234123412341234');
  await admin.createPrincipal('t_123456781234123412341234', 'x'.repeat(43));
  await admin.grantDatabaseOnly('t_123456781234123412341234', 'rental_123456781234123412341234');
  await admin.dropPrincipal('t_123456781234123412341234');
  await admin.dropDatabase('rental_123456781234123412341234');
  assert.match(calls.find(x => x.sql?.startsWith('GRANT')).sql, /ON `rental_123456781234123412341234`\.\*/);
  assert.equal(calls.filter(x => x.end).length, 6);
  await assert.rejects(admin.createDatabase('db`; DROP DATABASE mysql;--'), /TENANT_DATABASE_NAME_INVALID/);
});

test('secret, migration and isolation adapters validate contract and preserve version', async () => {
  const secrets = [];
  const store = createTenantProvisioningSecretStore({
    putSecret: async (...args) => secrets.push(args),
    deleteSecret: async ref => secrets.push(['delete', ref])
  });
  await store.put('tenant-db/12345678-1234-4123-8123-123456789abc', { user: 't_user', password: 'secret' });
  await store.delete('tenant-db/12345678-1234-4123-8123-123456789abc');
  assert.equal(secrets.length, 2);
  const runner = createTenantProvisioningMigrationRunner(async () => ({ schemaVersion: 'tenant-v3' }));
  assert.deepEqual(await runner.apply({
    appId: 'rental', tenantId: '12345678-1234-4123-8123-123456789abc',
    dbName: 'rental_123', secretRef: 'tenant-db/ref'
  }), { schemaVersion: 'tenant-v3' });
  const verifier = createTenantProvisioningIsolationVerifier(async () => ({ passed: true, schemaVersion: 'tenant-v3' }));
  assert.deepEqual(await verifier.verify({}), { passed: true, schemaVersion: 'tenant-v3' });
  const failing = createTenantProvisioningIsolationVerifier(async () => ({ passed: true }));
  assert.deepEqual(await failing.verify({}), { passed: false });
});

test('platform tenant registry provisioning adapter persists state transitions and audit events', async () => {
  const calls = [];
  const platformPool = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return [{ affectedRows: 1 }, []];
    },
    getConnection: async () => ({
      beginTransaction: async () => calls.push({ tx: 'begin' }),
      query: async (sql, values) => {
        calls.push({ sql, values, tx: true });
        return [{ affectedRows: 1 }, []];
      },
      commit: async () => calls.push({ tx: 'commit' }),
      rollback: async () => calls.push({ tx: 'rollback' }),
      release: () => calls.push({ tx: 'release' })
    })
  };
  const adapters = createPlatformTenantProvisioningAdapters({
    platformPool,
    databaseAdmin: {
      host: 'db.internal', port: 3306,
      createDatabase: async () => {}, createPrincipal: async () => {},
      grantDatabaseOnly: async () => {}, dropPrincipal: async () => {}, dropDatabase: async () => {}
    },
    secretManager: { putSecret: async () => {}, deleteSecret: async () => {} },
    runMigrations: async () => ({ schemaVersion: 'tenant-v1' }),
    verifyIsolation: async () => ({ passed: true, schemaVersion: 'tenant-v1' })
  });
  await adapters.registry.createProvisioningTenant({
    tenant_uuid: '12345678-1234-4123-8123-123456789abc', app_id: 'rental',
    display_label: 'Tenant', lifecycle_state: 'provisioning', db_host: 'db.internal',
    db_port: 3306, db_name: 'rental_123', db_secret_ref: 'tenant-db/ref', schema_version: null
  });
  await adapters.registry.activateTenant('12345678-1234-4123-8123-123456789abc', { schemaVersion: 'tenant-v1' });
  await adapters.registry.markProvisioningFailed('12345678-1234-4123-8123-123456789abc', 'PROVISIONING_FAILED');
  assert.ok(calls.some(x => x.sql?.includes("lifecycle_state = 'active'") && x.tx === true));
  assert.ok(calls.some(x => x.sql?.includes("lifecycle_state = 'provisioning_failed'") && x.tx === true));
  assert.equal(calls.filter(x => x.tx === 'commit').length, 2);
  assert.equal(calls.filter(x => x.tx === 'rollback').length, 0);
  assert.equal(calls.filter(x => x.tx === 'release').length, 2);
});


test('tenant registry activation rolls back lifecycle state when activation event persistence fails', async () => {
  const calls = [];
  const platformPool = {
    query: async () => [[], []],
    getConnection: async () => ({
      beginTransaction: async () => calls.push('begin'),
      query: async (sql) => {
        calls.push(sql);
        if (sql.startsWith('INSERT INTO platform_provisioning_events')) {
          throw Object.assign(new Error('event storage unavailable'), { code: 'DB_WRITE_FAILED' });
        }
        return [{ affectedRows: 1 }, []];
      },
      commit: async () => calls.push('commit'),
      rollback: async () => calls.push('rollback'),
      release: () => calls.push('release')
    })
  };
  const adapters = createPlatformTenantProvisioningAdapters({
    platformPool,
    databaseAdmin: {
      host: 'db.internal', port: 3306,
      createDatabase: async () => {}, createPrincipal: async () => {},
      grantDatabaseOnly: async () => {}, dropPrincipal: async () => {}, dropDatabase: async () => {}
    },
    secretManager: { putSecret: async () => {}, deleteSecret: async () => {} },
    runMigrations: async () => ({ schemaVersion: 'tenant-v1' }),
    verifyIsolation: async () => ({ passed: true, schemaVersion: 'tenant-v1' })
  });
  await assert.rejects(
    adapters.registry.activateTenant('12345678-1234-4123-8123-123456789abc', { schemaVersion: 'tenant-v1' }),
    /event storage unavailable/
  );
  assert.equal(calls.includes('rollback'), true);
  assert.equal(calls.includes('commit'), false);
  assert.equal(calls.at(-1), 'release');
});


test('registry activation reconciliation resolves committed and rolled-back activation outcomes under row lock', async () => {
  const calls = [];
  let lifecycleState = 'provisioning';
  const platformPool = {
    query: async () => [[], []],
    getConnection: async () => ({
      beginTransaction: async () => calls.push('begin'),
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT lifecycle_state')) return [[{ lifecycle_state: lifecycleState, schema_version: lifecycleState === 'active' ? 'tenant-v1' : null }], []];
        if (sql.startsWith("UPDATE platform_tenants SET lifecycle_state = 'active'")) {
          lifecycleState = 'active';
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 1 }, []];
      },
      commit: async () => calls.push('commit'),
      rollback: async () => calls.push('rollback'),
      release: () => calls.push('release')
    })
  };
  const adapters = createPlatformTenantProvisioningAdapters({
    platformPool,
    databaseAdmin: {
      host: 'db.internal', port: 3306,
      createDatabase: async () => {}, createPrincipal: async () => {},
      grantDatabaseOnly: async () => {}, dropPrincipal: async () => {}, dropDatabase: async () => {}
    },
    secretManager: { putSecret: async () => {}, deleteSecret: async () => {} },
    runMigrations: async () => ({ schemaVersion: 'tenant-v1' }),
    verifyIsolation: async () => ({ passed: true, schemaVersion: 'tenant-v1' })
  });
  const recovered = await adapters.registry.reconcileActivation('12345678-1234-4123-8123-123456789abc', { schemaVersion: 'tenant-v1' });
  assert.deepEqual(recovered, {
    tenantId: '12345678-1234-4123-8123-123456789abc',
    lifecycleState: 'active', schemaVersion: 'tenant-v1', reconciled: true
  });
  assert.ok(calls.some(x => typeof x === 'object' && x.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(x => typeof x === 'object' && x.sql.startsWith('INSERT INTO platform_provisioning_events') && x.values?.[1] === 'tenant_activation_reconciled'));
  const updateCount = calls.filter(x => typeof x === 'object' && x.sql.startsWith("UPDATE platform_tenants SET lifecycle_state = 'active'")).length;
  const alreadyActive = await adapters.registry.reconcileActivation('12345678-1234-4123-8123-123456789abc', { schemaVersion: 'tenant-v1' });
  assert.equal(alreadyActive.reconciled, false);
  assert.equal(calls.filter(x => typeof x === 'object' && x.sql.startsWith("UPDATE platform_tenants SET lifecycle_state = 'active'")).length, updateCount);
  await assert.rejects(
    adapters.registry.reconcileActivation('12345678-1234-4123-8123-123456789abc', { schemaVersion: 'tenant-v2' }),
    /TENANT_REGISTRY_RECONCILIATION_SCHEMA_MISMATCH/
  );
});
