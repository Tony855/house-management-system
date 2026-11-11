'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { createProductAuthenticator } = require('../server/product-auth');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secret = '0123456789abcdef0123456789abcdef';
const now = 1800000000;

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function token(claimOverrides = {}, headerOverrides = {}) {
  const header = b64({ alg: 'HS256', typ: 'JWT', kid: 'key-2026', ...headerOverrides });
  const claims = b64({
    iss: 'https://auth.example.test', aud: 'rental', appId: 'rental',
    sub: 'user-1', tenantId, jti: 'session-identifier-1234',
    iat: now - 10, exp: now + 300, ...claimOverrides
  });
  const signature = crypto.createHmac('sha256', secret).update(header + '.' + claims).digest('base64url');
  return header + '.' + claims + '.' + signature;
}
function setup(overrides = {}) {
  const calls = [];
  const authenticate = createProductAuthenticator({
    appId: 'rental',
    issuer: 'https://auth.example.test',
    keyProvider: { getVerificationKey: async input => { calls.push(['key', input]); return secret; } },
    sessionStore: { isSessionActive: async input => { calls.push(['session', input]); return true; } },
    now: () => now,
    ...overrides
  });
  return { authenticate, calls };
}
async function invoke(authenticate, authorization) {
  const req = { headers: { authorization } };
  let error;
  await authenticate(req, {}, value => { error = value || null; });
  return { req, error };
}

test('authenticates signed product token and attaches only verified claims', async () => {
  const { authenticate, calls } = setup();
  const result = await invoke(authenticate, 'Bearer ' + token());
  assert.equal(result.error, null);
  assert.deepEqual(result.req.auth, {
    authenticated: true, appId: 'rental', tenantId, userId: 'user-1',
    sessionId: 'session-identifier-1234', issuedAt: now - 10, expiresAt: now + 300
  });
  assert.equal(calls.length, 2);
});

test('rejects malformed, expired, overlong and cross-product tokens', async () => {
  const { authenticate } = setup();
  for (const value of [
    'Bearer malformed',
    'Bearer ' + token({ exp: now }),
    'Bearer ' + token({ exp: now + 3601 }),
    'Bearer ' + token({ aud: 'hotel', appId: 'hotel' }),
    'Bearer ' + token({ aud: ['rental', 'platform'] }),
    'Bearer ' + token({}, { alg: 'none' }),
    'Bearer ' + token({}, { crit: ['b64'], b64: false })
  ]) {
    const result = await invoke(authenticate, value);
    assert.ok(result.error);
    assert.equal(result.req.auth, undefined);
  }
});

test('rejects modified signatures and revoked sessions', async () => {
  const { authenticate } = setup();
  const signed = token();
  const modified = signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a');
  assert.equal((await invoke(authenticate, 'Bearer ' + modified)).error.code, 'TOKEN_INVALID');

  const revoked = setup({ sessionStore: { isSessionActive: async () => false } });
  assert.equal((await invoke(revoked.authenticate, 'Bearer ' + signed)).error.code, 'SESSION_REVOKED');
});

test('fails closed when verification keys or session store are unavailable', async () => {
  const noKey = setup({ keyProvider: { getVerificationKey: async () => null } });
  assert.equal((await invoke(noKey.authenticate, 'Bearer ' + token())).error.status, 503);
  const noSession = setup({ sessionStore: { isSessionActive: async () => { throw new Error('db offline'); } } });
  assert.equal((await invoke(noSession.authenticate, 'Bearer ' + token())).error.code, 'AUTHENTICATION_UNAVAILABLE');
});

test('requires explicit key and revocation adapters at construction', () => {
  assert.throws(() => createProductAuthenticator({ appId: 'rental', issuer: 'issuer' }), /PRODUCT_AUTH_KEY_PROVIDER_REQUIRED/);
});


test('same username subject remains isolated by tenant-bound platform sessions', async () => {
  const secondTenant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const active = new Set([
    ['user-1', tenantId, 'session-identifier-1234'].join(':'),
    ['user-1', secondTenant, 'session-identifier-5678'].join(':')
  ]);
  const { authenticate } = setup({
    sessionStore: {
      isSessionActive: async ({ userId, tenantId: scopedTenant, sessionId, appId }) =>
        appId === 'rental' && active.has([userId, scopedTenant, sessionId].join(':'))
    }
  });
  const first = await invoke(authenticate, 'Bearer ' + token());
  const second = await invoke(authenticate, 'Bearer ' + token({
    tenantId: secondTenant, jti: 'session-identifier-5678'
  }));
  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.equal(first.req.auth.userId, second.req.auth.userId);
  assert.notEqual(first.req.auth.tenantId, second.req.auth.tenantId);

  const swapped = await invoke(authenticate, 'Bearer ' + token({
    tenantId: secondTenant, jti: 'session-identifier-1234'
  }));
  assert.equal(swapped.error.code, 'SESSION_REVOKED');
});
