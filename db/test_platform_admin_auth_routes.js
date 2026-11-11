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
  const mfaService = {
    getStatus: async input => { calls.push(['mfa-status', input]); return { enabled: true }; },
    beginEnrollment: async input => { calls.push(['mfa-enroll', input]); return { secret: 'BASE32', otpauthUrl: 'otpauth://totp/test' }; },
    confirmEnrollment: async input => { calls.push(['mfa-confirm', input]); return { enabled: true, recoveryCodes: ['A1B2-C3D4-E5F6'] }; },
    rotateRecoveryCodes: async input => { calls.push(['mfa-rotate', input]); return { rotated: true, recoveryCodes: ['B1B2-C3D4-E5F6'] }; }
  };
  const authService = {
    login: async input => { calls.push(['login', input]); return { mfaRequired: true, challenge: 'challenge-token' }; },
    verifyChallenge: async input => { calls.push(['verify', input]); return { tokenType: 'Bearer', accessToken: 'signed-token' }; },
    authenticate: (req, _res, next) => { req.platformAuth = { adminId: 7, sessionId: 'session-id', mfaVerified: true }; next(); },
    stepUp: async input => { calls.push(['step-up', input]); return { stepUpVerified: true }; },
    logout: async input => { calls.push(['logout', input]); return true; }
  };
  const pool = {
    query: async () => [[], []],
    getConnection: async () => { throw new Error('not used'); }
  };
  return { app: createPlatformApi({ pool, adminAuthService: authService, mfaService }), calls };
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

    const status = await fetch(base + '/api/platform/auth/mfa/status', {
      headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: true });

    const enrollment = await fetch(base + '/api/platform/auth/mfa/enrollment', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(enrollment.status, 200);
    assert.equal(enrollment.headers.get('cache-control'), 'no-store');
    assert.equal((await enrollment.json()).secret, 'BASE32');

    const confirm = await fetch(base + '/api/platform/auth/mfa/enrollment/confirm', {
      method: 'POST', headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.headers.get('cache-control'), 'no-store');
    assert.equal((await confirm.json()).recoveryCodes.length, 1);

    const rotate = await fetch(base + '/api/platform/auth/mfa/recovery-codes/rotate', {
      method: 'POST', headers: { authorization: 'Bearer session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(rotate.status, 200);
    assert.equal(rotate.headers.get('cache-control'), 'no-store');
    assert.equal((await rotate.json()).rotated, true);

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
  assert.deepEqual(calls.map(call => call[0]), ['login', 'verify', 'mfa-status', 'mfa-enroll', 'mfa-confirm', 'mfa-rotate', 'step-up', 'logout']);
  assert.deepEqual(calls[4][1], { adminId: 7, code: '123456' });
  assert.deepEqual(calls[5][1], { adminId: 7, code: '123456' });
  assert.deepEqual(calls[6][1], { adminId: 7, sessionId: 'session-id', code: '123456' });
});

test('Platform API requires an authenticator before it can be created', () => {
  assert.throws(() => createPlatformApi({ pool: { query() {} } }), /PLATFORM_AUTHENTICATOR_REQUIRED/);
});

test('MFA enrollment requires a recently MFA-verified authenticated session', async () => {
  let enrollmentCalls = 0;
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => { req.platformAuth = { adminId: 7, sessionId: 'session-id', mfaVerified: false }; next(); },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({ enabled: false }),
    beginEnrollment: async () => { enrollmentCalls++; return {}; },
    confirmEnrollment: async () => ({}),
    rotateRecoveryCodes: async () => ({})
  };
  const app = createPlatformApi({ pool: { query: async () => [[], []] }, adminAuthService: authService, mfaService });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/auth/mfa/enrollment', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'PLATFORM_MFA_REAUTH_REQUIRED' });
  });
  assert.equal(enrollmentCalls, 0);
});
