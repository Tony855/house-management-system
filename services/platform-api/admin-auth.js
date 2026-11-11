'use strict';

const crypto = require('node:crypto');
const { verifyPassword: defaultVerifyPassword } = require('../../server/util');

function authError(code, status = 401) {
  throw Object.assign(new Error(code), { code, status });
}

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function createPlatformAdminAuthService({
  adminStore, challengeStore, sessionStore, mfaService, signingKeyProvider,
  verificationKeyProvider, issuer, verifyPassword = defaultVerifyPassword,
  loginRateLimiter, now = () => Math.floor(Date.now() / 1000),
  sessionLifetimeSeconds = 900, challengeLifetimeSeconds = 180, stepUpFreshSeconds = 300,
  randomBytes = crypto.randomBytes
}) {
  if (!adminStore || typeof adminStore.findByUsername !== 'function') throw new TypeError('PLATFORM_ADMIN_STORE_REQUIRED');
  if (!challengeStore || !['createChallenge', 'getChallenge', 'consumeChallenge', 'recordChallengeFailure'].every(k => typeof challengeStore[k] === 'function')) throw new TypeError('PLATFORM_ADMIN_CHALLENGE_STORE_REQUIRED');
  if (!sessionStore || !['createSession', 'getActiveSession', 'revokeSession', 'touchMfaVerified'].every(k => typeof sessionStore[k] === 'function')) throw new TypeError('PLATFORM_ADMIN_SESSION_STORE_REQUIRED');
  if (!mfaService || typeof mfaService.verify !== 'function') throw new TypeError('PLATFORM_ADMIN_MFA_SERVICE_REQUIRED');
  if (!signingKeyProvider || typeof signingKeyProvider.getSigningKey !== 'function' ||
      !verificationKeyProvider || typeof verificationKeyProvider.getVerificationKey !== 'function') throw new TypeError('PLATFORM_ADMIN_KEY_PROVIDER_REQUIRED');
  if (typeof issuer !== 'string' || !issuer || typeof verifyPassword !== 'function' || typeof now !== 'function') throw new TypeError('PLATFORM_ADMIN_AUTH_CONFIG_INVALID');
  if (!loginRateLimiter || !['assertAllowed', 'recordFailure', 'clear'].every(k => typeof loginRateLimiter[k] === 'function')) throw new TypeError('PLATFORM_ADMIN_RATE_LIMITER_REQUIRED');

  async function login({ username, password }) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{1,80}$/.test(username) ||
        typeof password !== 'string' || password.length < 1 || password.length > 256) authError('LOGIN_INVALID', 400);
    const identity = { username: username.toLowerCase() };
    await loginRateLimiter.assertAllowed(identity);
    let admin;
    try { admin = await adminStore.findByUsername(username); }
    catch (_) { authError('AUTHENTICATION_UNAVAILABLE', 503); }
    let valid = false;
    try { valid = !!admin && admin.status === 'active' && verifyPassword(password, admin.passwordHash) === true; }
    catch (_) { valid = false; }
    if (!valid) {
      await loginRateLimiter.recordFailure(identity);
      authError('INVALID_CREDENTIALS', 401);
    }
    if (admin.mfaRequired !== true) authError('PLATFORM_MFA_POLICY_INVALID', 503);
    await loginRateLimiter.clear(identity);
    const challenge = randomBytes(32).toString('base64url');
    if (typeof challenge !== 'string' || challenge.length < 40) authError('PLATFORM_AUTH_RANDOM_UNAVAILABLE', 503);
    await challengeStore.createChallenge({
      challengeHash: digest(challenge), adminId: admin.id,
      expiresAt: now() + challengeLifetimeSeconds
    });
    return Object.freeze({ mfaRequired: true, challenge, expiresIn: challengeLifetimeSeconds });
  }

  async function issueSession(adminId, mfaVerifiedAt) {
    const admin = await adminStore.findById(adminId);
    if (!admin || admin.status !== 'active') authError('PLATFORM_ADMIN_INACTIVE', 403);
    const issuedAt = now();
    const expiresAt = issuedAt + sessionLifetimeSeconds;
    const sessionId = randomBytes(32).toString('base64url');
    const key = await signingKeyProvider.getSigningKey({ appId: 'platform' });
    if (!key || typeof key.kid !== 'string' || !(typeof key.key === 'string' || Buffer.isBuffer(key.key)) || Buffer.byteLength(key.key) < 32) {
      authError('AUTH_SIGNING_KEY_UNAVAILABLE', 503);
    }
    await sessionStore.createSession({
      sessionId, adminId, issuedAt, expiresAt, mfaVerifiedAt,
      permissions: Array.isArray(admin.permissions) ? admin.permissions : []
    });
    const header = b64({ alg: 'HS256', typ: 'JWT', kid: key.kid });
    const claims = b64({
      iss: issuer, aud: 'platform', appId: 'platform', sub: String(adminId),
      jti: sessionId, iat: issuedAt, exp: expiresAt
    });
    const signature = crypto.createHmac('sha256', key.key).update(header + '.' + claims).digest('base64url');
    return Object.freeze({ tokenType: 'Bearer', accessToken: header + '.' + claims + '.' + signature, expiresIn: sessionLifetimeSeconds });
  }

  async function verifyChallenge({ challenge, code }) {
    if (typeof challenge !== 'string' || challenge.length < 40 || challenge.length > 128) authError('MFA_CHALLENGE_INVALID');
    const record = await challengeStore.getChallenge(digest(challenge));
    if (!record || record.consumedAt || record.expiresAt <= now()) authError('MFA_CHALLENGE_EXPIRED', 410);
    let verified;
    try { verified = await mfaService.verify({ adminId: record.adminId, code }); }
    catch (error) {
      await challengeStore.recordChallengeFailure({ challengeHash: digest(challenge), adminId: record.adminId });
      throw error;
    }
    if (!verified || verified.verified !== true) {
      await challengeStore.recordChallengeFailure({ challengeHash: digest(challenge), adminId: record.adminId });
      authError('PLATFORM_MFA_REQUIRED', 401);
    }
    const consumed = await challengeStore.consumeChallenge({ challengeHash: digest(challenge), adminId: record.adminId });
    if (consumed !== true) authError('MFA_CHALLENGE_REPLAYED', 401);
    return issueSession(record.adminId, verified.verifiedAt);
  }

  async function authenticate(req, _res, next) {
    try {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9._~-]+$/.test(header)) authError('AUTH_REQUIRED');
      const parts = header.slice(7).split('.');
      if (parts.length !== 3) authError('TOKEN_INVALID');
      let protectedHeader, claims;
      try {
        protectedHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch (_) { authError('TOKEN_INVALID'); }
      if (!protectedHeader || protectedHeader.alg !== 'HS256' || protectedHeader.typ !== 'JWT' ||
          Object.keys(protectedHeader).some(k => !['alg', 'typ', 'kid'].includes(k)) ||
          typeof protectedHeader.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(protectedHeader.kid)) authError('TOKEN_INVALID');
      const key = await verificationKeyProvider.getVerificationKey({ kid: protectedHeader.kid, appId: 'platform' });
      if (!(typeof key === 'string' || Buffer.isBuffer(key)) || Buffer.byteLength(key) < 32) authError('AUTH_KEY_UNAVAILABLE', 503);
      const expected = crypto.createHmac('sha256', key).update(parts[0] + '.' + parts[1]).digest();
      let supplied;
      try { supplied = Buffer.from(parts[2], 'base64url'); } catch (_) { authError('TOKEN_INVALID'); }
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) authError('TOKEN_INVALID');
      const current = now();
      if (claims.iss !== issuer || claims.aud !== 'platform' || claims.appId !== 'platform' ||
          typeof claims.sub !== 'string' || !/^\d+$/.test(claims.sub) ||
          typeof claims.jti !== 'string' || claims.jti.length < 40 ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.iat > current + 30 || claims.exp <= current || claims.exp <= claims.iat ||
          claims.exp - claims.iat > sessionLifetimeSeconds) authError('TOKEN_INVALID');
      const session = await sessionStore.getActiveSession({ sessionId: claims.jti, adminId: Number(claims.sub), now: current });
      if (!session || session.status !== 'active') authError('SESSION_REVOKED');
      const mfaAt = Number(session.mfaVerifiedAt);
      const mfaVerified = Number.isSafeInteger(mfaAt) && mfaAt <= current && current - mfaAt <= stepUpFreshSeconds;
      req.platformAuth = Object.freeze({
        authenticated: true, audience: 'platform', appId: 'platform',
        adminStatus: session.adminStatus, adminId: Number(claims.sub),
        permissions: Array.isArray(session.permissions) ? session.permissions : [],
        mfaVerified, mfaVerifiedAt: mfaAt,
        stepUpVerified: mfaVerified, stepUpVerifiedAt: mfaAt,
        sessionId: claims.jti
      });
      return next();
    } catch (error) {
      if (error && Number.isInteger(error.status)) return next(error);
      return next(Object.assign(new Error('AUTHENTICATION_UNAVAILABLE'), { code: 'AUTHENTICATION_UNAVAILABLE', status: 503 }));
    }
  }

  async function stepUp({ adminId, sessionId, code }) {
    const verified = await mfaService.verify({ adminId, code });
    if (!verified || verified.verified !== true) authError('PLATFORM_MFA_REQUIRED', 401);
    const updated = await sessionStore.touchMfaVerified({ adminId, sessionId, verifiedAt: verified.verifiedAt });
    if (updated !== true) authError('SESSION_REVOKED', 401);
    return Object.freeze({ stepUpVerified: true, verifiedAt: verified.verifiedAt });
  }

  async function logout({ adminId, sessionId }) {
    return sessionStore.revokeSession({ adminId, sessionId });
  }

  return Object.freeze({ login, verifyChallenge, authenticate, stepUp, logout });
}

module.exports = { createPlatformAdminAuthService };
