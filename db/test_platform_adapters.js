'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createTenantDatabaseSecretProvider
} = require('../server/platform-adapters');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('platform tenant registry reads only required tenant routing metadata', async () => {
  let query;
  const registry = createPlatformTenantRegistry({
    query: async (...args) => {
      query = args;
      return [[{ tenant_uuid: tenantId, app_id: 'rental', lifecycle_state: 'active', db_host: 'db', db_port: 3306, db_name: 'tenant_a', db_secret_ref: 'secret/a', schema_version: 'v1' }], []];
    }
  });
  const row = await registry.findTenantById(tenantId);
  assert.equal(row.tenant_uuid, tenantId);
  assert.equal(query[1][0], tenantId);
  assert.match(query[0], /WHERE tenant_uuid = \?/);
  assert.doesNotMatch(query[0], /password|credential/i);
});

test('platform registry resolves exact active login host and fixed product audience', async () => {
  let captured;
  const registry = createPlatformTenantRegistry({ query: async (...args) => { captured = args; return [[{ tenant_uuid: tenantId, app_id: 'rental', lifecycle_state: 'active' }], []]; } });
  const row = await registry.findTenantByLoginHost('tenant.example.test', 'rental');
  assert.equal(row.tenant_uuid, tenantId);
  assert.deepEqual(captured[1], ['tenant.example.test', 'rental']);
  assert.match(captured[0], /h\.hostname = \?/);
  assert.match(captured[0], /h\.status = 'active'/);
  assert.equal(await registry.findTenantByLoginHost('tenant.example.test', 'platform'), null);
});

test('product session store binds session to subject, tenant, app and expiry', async () => {
  let captured;
  const store = createPlatformProductSessionStore({
    query: async (...args) => {
      captured = args;
      return [[{ active: 1 }], []];
    }
  });
  assert.equal(await store.isSessionActive({
    sessionId: 'session-identifier-1234', userId: 'user-1', tenantId, appId: 'rental'
  }), true);
  assert.deepEqual(captured[1], ['session-identifier-1234', 'user-1', tenantId, 'rental']);
  assert.match(captured[0], /revoked_at IS NULL/);
  assert.match(captured[0], /expires_at > UTC_TIMESTAMP\(\)/);
});

test('platform product session store creates and revokes an exact scoped session', async () => {
  const calls = [];
  const store = createPlatformProductSessionStore({ query: async (...args) => { calls.push(args); return [{ affectedRows: 1 }, []]; } });
  await store.createSession({ sessionId: 'session-1', userId: 'u-1', tenantId, appId: 'rental', issuedAt: 1800000000, expiresAt: 1800000900 });
  assert.deepEqual(calls[0][1].slice(0, 4), ['session-1', 'rental', tenantId, 'u-1']);
  assert.equal(await store.revokeSession({ sessionId: 'session-1', userId: 'u-1', tenantId, appId: 'rental' }), true);
  assert.deepEqual(calls[1][1], ['session-1', 'u-1', tenantId, 'rental']);
  assert.match(calls[1][0], /revoked_at IS NULL/);
});

test('product session store rejects cross-product and incomplete session contexts', async () => {
  let calls = 0;
  const store = createPlatformProductSessionStore({ query: async () => { calls++; return [[{ active: 1 }], []]; } });
  assert.equal(await store.isSessionActive({ sessionId: 's', userId: 'u', tenantId, appId: 'platform' }), false);
  assert.equal(await store.isSessionActive({ sessionId: 's', userId: '', tenantId, appId: 'rental' }), false);
  assert.equal(calls, 0);
});

test('secret provider adapts secret-manager values without storing credentials in registry', async () => {
  let requested;
  const provider = createTenantDatabaseSecretProvider({
    getSecret: async ref => { requested = ref; return { user: 'tenant_user', password: 'secret-value', version: 'v2' }; }
  });
  const credentials = await provider.getDatabaseCredentials('secret/tenant-a');
  assert.equal(requested, 'secret/tenant-a');
  assert.deepEqual(credentials, { user: 'tenant_user', password: 'secret-value', version: 'v2' });
  assert.equal(Object.isFrozen(credentials), true);
  assert.throws(() => createTenantDatabaseSecretProvider(null), /TENANT_SECRET_MANAGER_REQUIRED/);
});

test('secret provider rejects malformed secret payloads', async () => {
  const provider = createTenantDatabaseSecretProvider({ getSecret: async () => ({ user: 'tenant' }) });
  await assert.rejects(provider.getDatabaseCredentials('secret/tenant-a'), error =>
    error.code === 'TENANT_DATABASE_CREDENTIALS_UNAVAILABLE' && error.status === 503);
});
