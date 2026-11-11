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
          status: 'active', adminStatus: 'active', mfaVerifiedAt: row.mfaVerifiedAt, permissions: row.permissions
        } : null;
      },
      touchMfaVerified: async ({ adminId, sessionId, verifiedAt }) => {
        const row = sessions.get(sessionId);
        if (!row || row.adminId !== adminId || row.revoked) return false;
        row.mfaVerifiedAt = verifiedAt; return true;
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
});
