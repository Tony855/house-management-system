'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createPlatformApi } = require('../services/platform-api/app');

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function fixture() {
  const calls = [];
  const authService = {
    login: async input => { calls.push(['login', input]); return { mfaRequired: true, challenge: 'challenge-token' }; },
    verifyChallenge: async input => { calls.push(['verify', input]); return { tokenType: 'Bearer', accessToken: 'signed-token' }; },
    authenticate: (req, _res, next) => { req.platformAuth = { adminId: 7, sessionId: 'session-id' }; next(); },
    stepUp: async input => { calls.push(['step-up', input]); return { stepUpVerified: true }; },
    logout: async input => { calls.push(['logout', input]); return true; }
  };
  const pool = {
    query: async () => [[], []],
    getConnection: async () => { throw new Error('not used'); }
  };
  return { app: createPlatformApi({ pool, adminAuthService: authService }), calls };
}

test('Platform API mounts password login, MFA challenge, step-up and logout routes', async () => {
  const { app, calls } = fixture();
  await withServer(app, async base => {
    const login = await fetch(base + '/api/platform/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'password' })
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { mfaRequired: true, challenge: 'challenge-token' });

    const verify = await fetch(base + '/api/platform/auth/mfa/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: 'challenge-token', code: '123456' })
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(await verify.json(), { tokenType: 'Bearer', accessToken: 'signed-token' });

    const stepUp = await fetch(base + '/api/platform/auth/step-up', {
      method: 'POST', headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(stepUp.status, 200);
    assert.equal((await stepUp.json()).stepUpVerified, true);

    const logout = await fetch(base + '/api/platform/auth/logout', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(logout.status, 204);
  });
  assert.deepEqual(calls.map(call => call[0]), ['login', 'verify', 'step-up', 'logout']);
  assert.deepEqual(calls[2][1], { adminId: 7, sessionId: 'session-id', code: '123456' });
});

test('Platform API requires an authenticator before it can be created', () => {
  assert.throws(() => createPlatformApi({ pool: { query() {} } }), /PLATFORM_AUTHENTICATOR_REQUIRED/);
});
