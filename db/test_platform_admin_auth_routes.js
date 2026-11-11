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
    authenticate: (req, _res, next) => {
      req.platformAuth = {
        adminId: 7, sessionId: 'session-id-1234567890', mfaVerified: true,
        stepUpVerified: true, permissions: ['platform:admins:write']
      };
      next();
    },
    stepUp: async input => { calls.push(['step-up', input]); return { stepUpVerified: true }; },
    logout: async input => { calls.push(['logout', input]); return true; }
  };
  const pool = { query: async () => [[], []], getConnection: async () => { throw new Error('not used'); } };
  const adminStore = { disableAdmin: async input => { calls.push(['disable-admin', input]); return true; } };
  return { app: createPlatformApi({ pool, adminAuthService: authService, mfaService, adminStore }), calls };
}

test('Platform API mounts password login, MFA lifecycle, step-up, admin disable and logout', async () => {
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

    const status = await fetch(base + '/api/platform/auth/mfa/status', { headers: { authorization: 'Bearer session-token' } });
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

    const disabled = await fetch(base + '/api/platform/auth/admins/8/disable', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(disabled.status, 204);

    const logout = await fetch(base + '/api/platform/auth/logout', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(logout.status, 204);
  });
  assert.deepEqual(calls.map(call => call[0]), [
    'login', 'verify', 'mfa-status', 'mfa-enroll', 'mfa-confirm',
    'mfa-rotate', 'step-up', 'disable-admin', 'logout'
  ]);
  assert.deepEqual(calls[4][1], { adminId: 7, code: '123456' });
  assert.deepEqual(calls[5][1], { adminId: 7, code: '123456' });
  assert.deepEqual(calls[6][1], { adminId: 7, sessionId: 'session-id-1234567890', code: '123456' });
  assert.deepEqual(calls[7][1], {
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890'
  });
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
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) },
    adminAuthService: authService, mfaService
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/auth/mfa/enrollment', {
      method: 'POST', headers: { authorization: 'Bearer session-token' }
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'PLATFORM_MFA_REAUTH_REQUIRED' });
  });
  assert.equal(enrollmentCalls, 0);
});

test('admin disable requires fresh step-up and explicit admin-management permission', async () => {
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => {
      req.platformAuth = { adminId: 7, sessionId: 'session-id-1234567890', permissions: [], stepUpVerified: false };
      next();
    },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({}), beginEnrollment: async () => ({}),
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  let called = false;
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) }, adminAuthService: authService, mfaService,
    adminStore: { disableAdmin: async () => { called = true; return true; } }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/auth/admins/8/disable', {
      method: 'POST', headers: { authorization: 'Bearer token' }
    });
    assert.equal(response.status, 403);
  });
  assert.equal(called, false);
});


test('administrator MFA reset requires admin-write permission, step-up and reason, then returns no secret material', async () => {
  const calls = [];
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => {
      req.platformAuth = {
        adminId: 7, sessionId: 'session-id-1234567890', permissions: ['platform:admins:write'],
        stepUpVerified: true, mfaVerified: true
      };
      next();
    },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({ enabled: true }), beginEnrollment: async () => ({}),
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) },
    adminAuthService: authService, mfaService,
    adminStore: { resetAdminMfa: async input => { calls.push(input); return true; } }
  });
  await withServer(app, async base => {
    const missingReason = await fetch(base + '/api/platform/auth/admins/8/mfa/reset', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ reason: 'short' })
    });
    assert.equal(missingReason.status, 400);

    const response = await fetch(base + '/api/platform/auth/admins/8/mfa/reset', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ reason: 'Lost authenticator device' })
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
  assert.deepEqual(calls, [{
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890',
    reason: 'Lost authenticator device'
  }]);
});

test('administrator MFA reset rejects callers without fresh step-up or admin-write permission', async () => {
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => {
      req.platformAuth = {
        adminId: 7, sessionId: 'session-id-1234567890', permissions: [],
        stepUpVerified: false, mfaVerified: true
      };
      next();
    },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({}), beginEnrollment: async () => ({}),
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  let called = false;
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) },
    adminAuthService: authService, mfaService,
    adminStore: { resetAdminMfa: async () => { called = true; return true; } }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/auth/admins/8/mfa/reset', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ reason: 'Lost authenticator device' })
    });
    assert.equal(response.status, 403);
  });
  assert.equal(called, false);
});


test('administrator re-enable requires step-up and exposes separate request and approval actions', async () => {
  const calls = [];
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => {
      req.platformAuth = {
        adminId: 9, sessionId: 'session-id-9876543210',
        permissions: ['platform:admins:write'], stepUpVerified: true, mfaVerified: true
      };
      next();
    },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({}), beginEnrollment: async () => ({}),
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  const adminStore = {
    requestAdminReenable: async input => { calls.push(['request', input]); return 42; },
    approveAdminReenable: async input => { calls.push(['approve', input]); return true; }
  };
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) },
    adminAuthService: authService, mfaService, adminStore
  });
  await withServer(app, async base => {
    const request = await fetch(base + '/api/platform/auth/admins/8/reenable/request', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ reason: 'Restore after identity verification' })
    });
    assert.equal(request.status, 201);
    assert.deepEqual(await request.json(), { requestId: 42, status: 'pending' });

    const approve = await fetch(base + '/api/platform/auth/admins/8/reenable/approve', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ requestId: 42 })
    });
    assert.equal(approve.status, 204);
  });
  assert.deepEqual(calls.map(call => call[0]), ['request', 'approve']);
  assert.deepEqual(calls[0][1], {
    actorAdminId: 9, targetAdminId: 8, sessionId: 'session-id-9876543210',
    reason: 'Restore after identity verification'
  });
  assert.deepEqual(calls[1][1], {
    actorAdminId: 9, targetAdminId: 8, requestId: 42,
    sessionId: 'session-id-9876543210'
  });
});

test('administrator re-enable request rejects missing reason before calling the store', async () => {
  const authService = {
    login: async () => ({}), verifyChallenge: async () => ({}),
    authenticate: (req, _res, next) => {
      req.platformAuth = {
        adminId: 9, sessionId: 'session-id-9876543210',
        permissions: ['platform:admins:write'], stepUpVerified: true
      };
      next();
    },
    stepUp: async () => ({}), logout: async () => true
  };
  const mfaService = {
    getStatus: async () => ({}), beginEnrollment: async () => ({}),
    confirmEnrollment: async () => ({}), rotateRecoveryCodes: async () => ({})
  };
  let called = false;
  const app = createPlatformApi({
    pool: { query: async () => [[], []], getConnection: async () => ({}) },
    adminAuthService: authService, mfaService,
    adminStore: { requestAdminReenable: async () => { called = true; return 1; } }
  });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/platform/auth/admins/8/reenable/request', {
      method: 'POST', headers: {
        authorization: 'Bearer session-token', 'content-type': 'application/json'
      }, body: JSON.stringify({ reason: 'short' })
    });
    assert.equal(response.status, 400);
  });
  assert.equal(called, false);
});
