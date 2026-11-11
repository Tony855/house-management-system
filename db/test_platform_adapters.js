'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createPlatformLoginRateLimiter,
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

test('platform login limiter atomically stores keyed identity hashes and blocks after threshold', async () => {
  const state = { row: null, sql: [] };
  const pool = {
    async query(sql, params) {
      state.sql.push([sql, params]);
      if (sql.startsWith('SELECT (blocked_until')) return [[state.row ? { blocked: state.row.blocked_until ? 1 : 0 } : undefined].filter(Boolean), []];
      if (sql.startsWith('DELETE FROM platform_login_attempts')) { state.row = null; return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith('INSERT INTO platform_login_attempts')) {
        const failures = state.row ? state.row.failures + 1 : 1;
        state.row = { failures, blocked_until: failures >= params[3] ? new Date(Date.now() + params[4] * 1000) : null };
        return [{ affectedRows: 1 }, []];
      }
      throw new Error('unexpected SQL: ' + sql);
    }
  };
  const limiter = createPlatformLoginRateLimiter(pool, {
    hmacKey: '0123456789abcdef0123456789abcdef',
    maxAttempts: 3, windowSeconds: 900, blockSeconds: 900
  });
  const identity = { appId: 'rental', host: 'Tenant.Example.Test', username: 'Alice' };
  await limiter.assertAllowed(identity);
  await limiter.recordFailure(identity);
  await limiter.recordFailure(identity);
  await limiter.recordFailure(identity);
  assert.equal(state.row.failures, 3);
  assert.ok(state.row.blocked_until instanceof Date);
  await assert.rejects(limiter.assertAllowed(identity), error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429);
  await limiter.clear(identity);
  assert.equal(state.row, null);
  assert.equal(state.sql.some(([sql]) => /username|hostname/i.test(sql)), false);
  const hashParams = state.sql.find(([sql]) => sql.startsWith('INSERT INTO platform_login_attempts'))[1];
  assert.match(hashParams[1], /^[a-f0-9]{64}$/);
  assert.notEqual(hashParams[1], identity.username);
  assert.match(state.sql.find(([sql]) => sql.startsWith('INSERT INTO platform_login_attempts'))[0], /ON DUPLICATE KEY UPDATE/);
});

test('platform login limiter requires a query pool and strong HMAC key', () => {
  assert.throws(() => createPlatformLoginRateLimiter({}, { hmacKey: 'short' }), /PLATFORM_DB_QUERY_POOL_REQUIRED/);
  assert.throws(() => createPlatformLoginRateLimiter({ query: async () => [[], []] }, { hmacKey: 'short' }), /LOGIN_RATE_LIMIT_HMAC_KEY_REQUIRED/);
});

test('platform login limiter propagates database failures without treating them as allowed', async () => {
  const pool = { query: async () => { throw new Error('database unavailable'); } };
  const limiter = createPlatformLoginRateLimiter(pool, { hmacKey: '0123456789abcdef0123456789abcdef' });
  await assert.rejects(limiter.recordFailure({ appId: 'rental', host: 'a.example.test', username: 'user' }), /database unavailable/);
  await assert.rejects(limiter.assertAllowed({ appId: 'rental', host: 'a.example.test', username: 'user' }), /database unavailable/);
});


test('platform admin login limiter accepts only the dedicated platform namespace', async () => {
  const calls = [];
  const limiter = createPlatformLoginRateLimiter({
    query: async (sql, params) => { calls.push([sql, params]); return [[], []]; }
  }, { hmacKey: 'platform-admin-login-hmac-key-at-least-32-bytes' });
  const identity = { appId: 'platform', host: 'platform', username: 'Root.Admin' };
  assert.equal(await limiter.assertAllowed(identity), true);
  await limiter.recordFailure(identity);
  assert.equal(calls[0][1][0], 'platform');
  assert.equal(calls[1][1][0], 'platform');
  assert.match(calls[1][1][1], /^[a-f0-9]{64}$/);
  assert.notEqual(calls[1][1][1], identity.username);
  assert.throws(() => limiter.assertAllowed({ appId: 'unknown', host: 'platform', username: 'root' }), /LOGIN_RATE_LIMIT_IDENTITY_INVALID/);
});
