'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformAdminAuthService } = require('../services/platform-api/admin-auth');

function fixture(overrides = {}) {
  const calls = [];
  const challenges = new Map();
  const sessions = new Map();
  const admin = { id: 7, status: 'active', mfaRequired: true, passwordHash: 'hash', permissions: ['platform:read', 'plans:write'] };
  const service = createPlatformAdminAuthService({
    adminStore: {
      findByUsername: async username => username === 'root' ? admin : null,
      findById: async id => id === 7 ? admin : null
    },
    challengeStore: {
      createChallenge: async record => { challenges.set(record.challengeHash, { ...record, consumedAt: null, attempts: 0 }); },
      getChallenge: async hash => challenges.get(hash) || null,
      recordChallengeFailure: async ({ challengeHash }) => {
        const row = challenges.get(challengeHash);
        if (!row || row.consumedAt || row.attempts >= 5) return false;
        row.attempts += 1; return true;
      },
      consumeChallenge: async ({ challengeHash, adminId }) => {
        const row = challenges.get(challengeHash);
        if (!row || row.adminId !== adminId || row.consumedAt || row.attempts >= 5) return false;
        row.consumedAt = 1800000000; return true;
      }
    },
    sessionStore: {
      createSession: async record => { sessions.set(record.sessionId, { ...record, status: 'active', adminStatus: 'active' }); calls.push(['create-session', record]); },
      getActiveSession: async ({ sessionId, adminId }) => {
        const row = sessions.get(sessionId);
        return row && row.adminId === adminId && !row.revoked ? {
          status: 'active', adminStatus: 'active', mfaVerifiedAt: row.mfaVerifiedAt, stepUpVerifiedAt: row.stepUpVerifiedAt ?? null, permissions: row.permissions
        } : null;
      },
      touchMfaVerified: async ({ adminId, sessionId, verifiedAt }) => {
        const row = sessions.get(sessionId);
        if (!row || row.adminId !== adminId || row.revoked) return false;
        row.mfaVerifiedAt = verifiedAt; return true;
      },
      touchStepUpVerified: async ({ adminId, sessionId, verifiedAt }) => {
        const row = sessions.get(sessionId);
        if (!row || row.adminId !== adminId || row.revoked) return false;
        row.stepUpVerifiedAt = verifiedAt; return true;
      },
      revokeSession: async ({ adminId, sessionId }) => {
        const row = sessions.get(sessionId);
        if (!row || row.adminId !== adminId) return false;
        row.revoked = true; return true;
      }
    },
    mfaService: { verify: async ({ adminId, code }) => {
      calls.push(['mfa', adminId, code]);
      if (code !== '123456') throw Object.assign(new Error('PLATFORM_MFA_CODE_INVALID'), { code: 'PLATFORM_MFA_CODE_INVALID', status: 401 });
      return { verified: true, method: 'totp', verifiedAt: 1800000000 };
    } },
    signingKeyProvider: { getSigningKey: async () => ({ kid: 'platform-key-1', key: 'platform-signing-key-material-at-least-32-bytes' }) },
    verificationKeyProvider: { getVerificationKey: async () => 'platform-signing-key-material-at-least-32-bytes' },
    issuer: 'https://platform.example.test',
    verifyPassword: (password, hash) => password === 'correct' && hash === 'hash',
    loginRateLimiter: {
      assertAllowed: async identity => calls.push(['allowed', identity]),
      recordFailure: async identity => calls.push(['failure', identity]),
      clear: async identity => calls.push(['clear', identity])
    },
    now: () => 1800000000,
    ...overrides
  });
  return { service, calls, challenges, sessions };
}

test('platform login verifies password first and returns only a short-lived MFA challenge', async () => {
  const { service, calls, challenges } = fixture();
  const result = await service.login({ username: 'root', password: 'correct' });
  assert.equal(result.mfaRequired, true);
  assert.equal(result.expiresIn, 180);
  assert.equal(result.challenge.length >= 40, true);
  assert.equal(challenges.size, 1);
  assert.equal(calls.some(call => call[0] === 'create-session'), false);
  assert.equal(calls.some(call => call[0] === 'clear'), true);
  assert.deepEqual(calls.find(call => call[0] === 'allowed')[1], {
    appId: 'platform', host: 'platform', username: 'root'
  });
});

test('invalid credentials are throttled and never create MFA challenge or session', async () => {
  const { service, calls, challenges, sessions } = fixture();
  await assert.rejects(service.login({ username: 'root', password: 'wrong' }),
    error => error.code === 'INVALID_CREDENTIALS');
  assert.equal(calls.some(call => call[0] === 'failure'), true);
  assert.equal(challenges.size, 0);
  assert.equal(sessions.size, 0);
});

test('MFA challenge creates platform-audience JWT only after successful verification', async () => {
  const { service, sessions } = fixture();
  const pending = await service.login({ username: 'root', password: 'correct' });
  const result = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  assert.equal(result.tokenType, 'Bearer');
  const [header, claims, signature] = result.accessToken.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).kid, 'platform-key-1');
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(payload.aud, 'platform');
  assert.equal(payload.appId, 'platform');
  assert.equal(payload.sub, '7');
  assert.equal(Buffer.from(signature, 'base64url').length, 32);
  assert.equal(sessions.size, 1);
});

test('MFA challenge failures are counted and challenge cannot be replayed', async () => {
  const { service, challenges } = fixture();
  const pending = await service.login({ username: 'root', password: 'correct' });
  await assert.rejects(service.verifyChallenge({ challenge: pending.challenge, code: '000000' }),
    error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  const row = [...challenges.values()][0];
  assert.equal(row.attempts, 1);
  const session = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  assert.ok(session.accessToken);
  await assert.rejects(service.verifyChallenge({ challenge: pending.challenge, code: '123456' }),
    error => error.code === 'MFA_CHALLENGE_EXPIRED');
});

test('MFA failures share an account-level rate limit across fresh challenges', async () => {
  const calls = [];
  let failures = 0;
  const { service } = fixture({
    loginRateLimiter: {
      assertAllowed: async identity => {
        calls.push(['allowed', identity.username]);
        if (identity.username === 'admin:7' && failures >= 2) {
          throw Object.assign(new Error('LOGIN_RATE_LIMITED'), { code: 'LOGIN_RATE_LIMITED', status: 429 });
        }
      },
      recordFailure: async identity => {
        calls.push(['failure', identity.username]);
        if (identity.username === 'admin:7') failures += 1;
      },
      clear: async identity => calls.push(['clear', identity.username])
    }
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = await service.login({ username: 'root', password: 'correct' });
    await assert.rejects(service.verifyChallenge({ challenge: pending.challenge, code: '000000' }),
      error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  }

  const freshChallenge = await service.login({ username: 'root', password: 'correct' });
  await assert.rejects(service.verifyChallenge({ challenge: freshChallenge.challenge, code: '123456' }),
    error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429);
  assert.equal(calls.filter(call => call[0] === 'failure' && call[1] === 'admin:7').length, 2);
  assert.equal(calls.some(call => call[0] === 'allowed' && call[1] === 'admin:7'), true);
});

test('step-up MFA failures use the same account-level rate limit', async () => {
  let failures = 0;
  const { service } = fixture({
    loginRateLimiter: {
      assertAllowed: async identity => {
        if (identity.username === 'admin:7' && failures >= 1) {
          throw Object.assign(new Error('LOGIN_RATE_LIMITED'), { code: 'LOGIN_RATE_LIMITED', status: 429 });
        }
      },
      recordFailure: async identity => { if (identity.username === 'admin:7') failures += 1; },
      clear: async () => true
    }
  });
  const pending = await service.login({ username: 'root', password: 'correct' });
  const issued = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  const payload = JSON.parse(Buffer.from(issued.accessToken.split('.')[1], 'base64url').toString());
  await assert.rejects(service.stepUp({ adminId: 7, sessionId: payload.jti, code: '000000' }),
    error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  await assert.rejects(service.stepUp({ adminId: 7, sessionId: payload.jti, code: '123456' }),
    error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429);
});

test('platform authenticator validates signed token and loads current session permissions', async () => {
  const { service } = fixture();
  const pending = await service.login({ username: 'root', password: 'correct' });
  const issued = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  const req = { headers: { authorization: 'Bearer ' + issued.accessToken } };
  let nextError;
  await service.authenticate(req, {}, error => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.equal(req.platformAuth.authenticated, true);
  assert.equal(req.platformAuth.audience, 'platform');
  assert.deepEqual(req.platformAuth.permissions, ['platform:read', 'plans:write']);
  assert.equal(req.platformAuth.mfaVerified, true);
  assert.equal(req.platformAuth.stepUpVerified, false, 'login MFA must not satisfy sensitive-operation step-up');
  await service.logout({ adminId: 7, sessionId: req.platformAuth.sessionId });
  const revokedReq = { headers: { authorization: 'Bearer ' + issued.accessToken } };
  await service.authenticate(revokedReq, {}, error => { nextError = error; });
  assert.equal(nextError.code, 'SESSION_REVOKED');
});

test('step-up verifies MFA again and updates the existing active session', async () => {
  const { service, sessions } = fixture();
  const pending = await service.login({ username: 'root', password: 'correct' });
  const issued = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  const payload = JSON.parse(Buffer.from(issued.accessToken.split('.')[1], 'base64url').toString());
  const result = await service.stepUp({ adminId: 7, sessionId: payload.jti, code: '123456' });
  assert.equal(result.stepUpVerified, true);
  assert.equal(sessions.get(payload.jti).mfaVerifiedAt, 1800000000);
  assert.equal(sessions.get(payload.jti).stepUpVerifiedAt, 1800000000);
  const req = { headers: { authorization: 'Bearer ' + issued.accessToken } };
  await service.authenticate(req, {}, error => { assert.equal(error, undefined); });
  assert.equal(req.platformAuth.stepUpVerified, true);
});


test('platform admin login fails closed as 503 when the limiter database is unavailable', async () => {
  const { service } = fixture({
    loginRateLimiter: {
      assertAllowed: async () => { throw new Error('platform database unavailable'); },
      recordFailure: async () => true,
      clear: async () => true
    }
  });
  await assert.rejects(service.login({ username: 'root', password: 'correct' }),
    error => error.code === 'AUTHENTICATION_UNAVAILABLE' && error.status === 503);
});

test('MFA infrastructure failures do not consume the user challenge failure budget', async () => {
  const { service, challenges } = fixture({
    mfaService: { verify: async () => {
      throw Object.assign(new Error('KMS unavailable'), { code: 'PLATFORM_MFA_ENCRYPTION_UNAVAILABLE', status: 503 });
    } }
  });
  const pending = await service.login({ username: 'root', password: 'correct' });
  await assert.rejects(service.verifyChallenge({ challenge: pending.challenge, code: '123456' }),
    error => error.status === 503);
  assert.equal([...challenges.values()][0].attempts, 0);
});


test('platform login accepts the full documented 80-character username limit', async () => {
  const { service, calls } = fixture({
    adminStore: {
      findByUsername: async () => null,
      findById: async () => null
    }
  });
  await assert.rejects(service.login({ username: 'u'.repeat(80), password: 'wrong' }),
    error => error.code === 'INVALID_CREDENTIALS');
  assert.equal(calls.some(call => call[0] === 'allowed' && call[1].username.length === 80), true);
});

test('platform signing key identifiers are validated before issuing a token', async () => {
  const { service } = fixture({
    signingKeyProvider: {
      getSigningKey: async () => ({ kid: 'invalid kid', key: 'platform-signing-key-material-at-least-32-bytes' })
    }
  });
  const pending = await service.login({ username: 'root', password: 'correct' });
  await assert.rejects(service.verifyChallenge({ challenge: pending.challenge, code: '123456' }),
    error => error.code === 'AUTH_SIGNING_KEY_UNAVAILABLE' && error.status === 503);
});

test('platform auth rejects non-canonical base64url token segments', async () => {
  const { service } = fixture();
  const pending = await service.login({ username: 'root', password: 'correct' });
  const issued = await service.verifyChallenge({ challenge: pending.challenge, code: '123456' });
  const [header, claims, signature] = issued.accessToken.split('.');
  const malformedToken = [header + '_', claims, signature].join('.');
  const req = { headers: { authorization: 'Bearer ' + malformedToken } };
  await service.authenticate(req, {}, error => {
    assert.equal(error.code, 'TOKEN_INVALID');
  });
});

test('platform auth rejects unsafe lifetime configuration at construction', () => {
  assert.throws(() => fixture({ sessionLifetimeSeconds: 0 }), /PLATFORM_ADMIN_AUTH_CONFIG_INVALID/);
  assert.throws(() => fixture({ challengeLifetimeSeconds: 601 }), /PLATFORM_ADMIN_AUTH_CONFIG_INVALID/);
});
