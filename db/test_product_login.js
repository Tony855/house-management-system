'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { createProductLoginService, normalizeLoginHost } = require('../server/product-login');

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secret = 'test-signing-key-material-at-least-32-bytes';
const issuedAt = 1800000000;

function setup(overrides = {}) {
  const calls = [];
  const tenant = {
    tenant_uuid: tenantA, app_id: 'rental', lifecycle_state: 'active',
    db_host: 'db.internal', db_port: 3306, db_name: 'tenant_a',
    db_secret_ref: 'secret/tenant-a', schema_version: 'v1'
  };
  const service = createProductLoginService({
    appId: 'rental', issuer: 'https://auth.example.test',
    registry: {
      findTenantByLoginHost: async (host, appId) => {
        calls.push(['host', host, appId]);
        return host === 'tenant.example.test' && appId === 'rental'
          ? { app_id: 'rental', tenant_uuid: tenantA, lifecycle_state: 'active' } : null;
      },
      findTenantById: async id => id === tenantA ? tenant : null
    },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'tenant_user', password: 'db-password' }) },
    poolManager: { getPool: async context => {
      calls.push(['pool', context.tenantId]);
      return { execute: async (sql, params) => {
        calls.push(['query', sql, params]);
        return [[{ id: 17, username: 'same-user', password: 'hash', real_name: 'Tenant User', role: 'admin', mode: 'rental' }]];
      } };
    } },
    sessionStore: {
      createSession: async input => { calls.push(['create', input]); },
      revokeSession: async input => { calls.push(['revoke', input]); }
    },
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'key-1', key: secret }) },
    loginRateLimiter: { assertAllowed: async input => { calls.push(['rate-allowed', input]); }, recordFailure: async input => { calls.push(['rate-failure', input]); }, clear: async input => { calls.push(['rate-clear', input]); } },
    verifyPassword: (password, hash) => password === 'correct' && hash === 'hash',
    now: () => issuedAt,
    ...overrides
  });
  return { service, calls };
}

test('normalizes only exact DNS login hosts', () => {
  assert.equal(normalizeLoginHost('Tenant.Example.Test.'), 'tenant.example.test');
  for (const host of ['tenant.example.test:443', '127.0.0.1', '*.example.test', 'example', 'bad host']) {
    assert.equal(normalizeLoginHost(host), null);
  }
});

test('issues product/tenant-bound JWT and persists active session after password verification', async () => {
  const { service, calls } = setup();
  const result = await service.login({ host: 'Tenant.Example.Test', username: 'same-user', password: 'correct' });
  assert.equal(result.tokenType, 'Bearer');
  assert.equal(result.expiresIn, 900);
  assert.equal(result.user.id, '17');
  const [header, claims, signature] = result.accessToken.split('.');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).kid, 'key-1');
  assert.equal(decoded.aud, 'rental');
  assert.equal(decoded.tenantId, tenantA);
  assert.equal(decoded.sub, '17');
  assert.equal(Buffer.from(signature, 'base64url').length, 32);
  assert.equal(calls.some(x => x[0] === 'create'), true);
  assert.equal(calls[0][0], 'rate-allowed');
  assert.equal(calls.some(x => x[0] === 'rate-clear'), true);
});

test('same username in another tenant cannot be selected by client tenant input', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.login({
    host: 'other.example.test', username: 'same-user', password: 'correct', tenantId: tenantB
  }), error => error.code === 'INVALID_CREDENTIALS' && error.status === 401);
  assert.equal(calls.some(x => x[0] === 'pool'), false);
  assert.equal(calls.some(x => x[0] === 'rate-failure'), true);
});

test('rejects wrong password without creating a session', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.login({ host: 'tenant.example.test', username: 'same-user', password: 'wrong' }),
    error => error.code === 'INVALID_CREDENTIALS' && error.status === 401);
  assert.equal(calls.some(x => x[0] === 'create'), false);
  assert.equal(calls.some(x => x[0] === 'rate-failure'), true);
});

test('fails closed for inactive tenant and missing signing key', async () => {
  const inactive = setup({ registry: {
    findTenantByLoginHost: async () => ({ app_id: 'rental', tenant_uuid: tenantA, lifecycle_state: 'suspended' }),
    findTenantById: async () => ({ tenant_uuid: tenantA, app_id: 'rental', lifecycle_state: 'suspended' })
  } });
  await assert.rejects(inactive.service.login({ host: 'tenant.example.test', username: 'same-user', password: 'correct' }),
    error => error.status === 401);
  const noKey = setup({ signingKeyProvider: { getSigningKey: async () => null } });
  await assert.rejects(noKey.service.login({ host: 'tenant.example.test', username: 'same-user', password: 'correct' }),
    error => error.code === 'AUTH_SIGNING_KEY_UNAVAILABLE');
});

test('logout revokes only the exact product/tenant/user session tuple', async () => {
  const { service, calls } = setup();
  await service.logout({ authenticated: true, appId: 'rental', tenantId: tenantA, userId: '17', sessionId: 'session-1' });
  const revoke = calls.find(x => x[0] === 'revoke')[1];
  assert.deepEqual(revoke, { sessionId: 'session-1', userId: '17', tenantId: tenantA, appId: 'rental' });
  await assert.rejects(service.logout({ authenticated: true, appId: 'hotel' }), /AUTH_REQUIRED/);
});

test('malformed password hashes never leak verifier exceptions', async () => {
  const { service } = setup({ verifyPassword: () => { throw new Error('bad hash'); } });
  await assert.rejects(service.login({ host: 'tenant.example.test', username: 'same-user', password: 'x' }),
    error => error.code === 'INVALID_CREDENTIALS');
});

test('invalid host and credential payloads are rejected before tenant lookup', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.login({ host: 'tenant.example.test:443', username: 'bad/name', password: 'x' }),
    error => error.code === 'LOGIN_INVALID');
  assert.equal(calls.length, 0);
});

test('login throttling blocks requests before tenant lookup and propagates limiter outages', async () => {
  const blocked = setup({ loginRateLimiter: {
    assertAllowed: async () => { throw Object.assign(new Error('LOGIN_RATE_LIMITED'), { code: 'LOGIN_RATE_LIMITED', status: 429 }); },
    recordFailure: async () => {}, clear: async () => {}
  } });
  await assert.rejects(blocked.service.login({ host: 'tenant.example.test', username: 'same-user', password: 'wrong' }),
    error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429);
  assert.equal(blocked.calls.some(x => x[0] === 'host'), false);

  const unavailable = setup({ loginRateLimiter: {
    assertAllowed: async () => { throw new Error('platform DB offline'); },
    recordFailure: async () => {}, clear: async () => {}
  } });
  await assert.rejects(unavailable.service.login({ host: 'tenant.example.test', username: 'same-user', password: 'wrong' }),
    error => error.code === 'LOGIN_RATE_LIMITER_UNAVAILABLE' && error.status === 503);
  assert.equal(unavailable.calls.some(x => x[0] === 'host'), false);
});

test('successful login clears only the matching normalized host/user rate-limit identity', async () => {
  const { service, calls } = setup();
  await service.login({ host: 'TENANT.example.test.', username: 'same-user', password: 'correct' });
  const identity = calls.find(x => x[0] === 'rate-clear')[1];
  assert.deepEqual(identity, { appId: 'rental', host: 'tenant.example.test', username: 'same-user' });
});
