'use strict';

const crypto = require('node:crypto');
const { resolveTenantContext } = require('./tenant-registry');
const { verifyPassword: defaultVerifyPassword } = require('./util');

const APP_IDS = new Set(['rental', 'hotel', 'property']);
const USERNAME_RE = /^[A-Za-z0-9_@.-]{1,50}$/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeLoginHost(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let host = value.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const labels = host.split('.');
  if (labels.length < 2 || labels.length > 127 ||
      labels.some(label => !HOST_LABEL_RE.test(label)) ||
      !/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
  return host;
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

function createProductLoginService({
  appId, issuer, registry, secretProvider, poolManager, sessionStore, signingKeyProvider, loginRateLimiter,
  verifyPassword = defaultVerifyPassword, now = () => Math.floor(Date.now() / 1000),
  lifetimeSeconds = 900
}) {
  if (!APP_IDS.has(appId)) throw new TypeError('PRODUCT_LOGIN_APP_ID_INVALID');
  if (typeof issuer !== 'string' || !issuer) throw new TypeError('PRODUCT_LOGIN_ISSUER_REQUIRED');
  if (!registry || typeof registry.findTenantByLoginHost !== 'function' ||
      typeof registry.findTenantById !== 'function') throw new TypeError('PRODUCT_LOGIN_REGISTRY_REQUIRED');
  if (!secretProvider || typeof secretProvider.getDatabaseCredentials !== 'function') throw new TypeError('PRODUCT_LOGIN_SECRET_PROVIDER_REQUIRED');
  if (!poolManager || typeof poolManager.getPool !== 'function') throw new TypeError('PRODUCT_LOGIN_POOL_MANAGER_REQUIRED');
  if (!sessionStore || typeof sessionStore.createSession !== 'function' ||
      typeof sessionStore.revokeSession !== 'function') throw new TypeError('PRODUCT_LOGIN_SESSION_STORE_REQUIRED');
  if (!signingKeyProvider || typeof signingKeyProvider.getSigningKey !== 'function') throw new TypeError('PRODUCT_LOGIN_SIGNING_KEY_PROVIDER_REQUIRED');
  if (typeof verifyPassword !== 'function') throw new TypeError('PRODUCT_LOGIN_PASSWORD_VERIFIER_REQUIRED');\n  if (!loginRateLimiter || typeof loginRateLimiter.assertAllowed !== 'function' ||\n      typeof loginRateLimiter.recordFailure !== 'function' || typeof loginRateLimiter.clear !== 'function') {\n    throw new TypeError('PRODUCT_LOGIN_RATE_LIMITER_REQUIRED');\n  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 3600) throw new TypeError('PRODUCT_LOGIN_LIFETIME_INVALID');

  async function runRateLimit(action, identity) {
    try {
      return await loginRateLimiter[action](identity);
    } catch (error) {
      if (error && error.code === 'LOGIN_RATE_LIMITED') throw error;
      throw Object.assign(new Error('LOGIN_RATE_LIMITER_UNAVAILABLE'), {
        code: 'LOGIN_RATE_LIMITER_UNAVAILABLE', status: 503
      });
    }
  }

  async function login({ host, username, password }) {
    const hostname = normalizeLoginHost(host);
    if (!hostname || typeof username !== 'string' || !USERNAME_RE.test(username) ||
        typeof password !== 'string' || password.length < 1 || password.length > 100) {
      throw Object.assign(new Error('LOGIN_INVALID'), { code: 'LOGIN_INVALID', status: 400 });
    }
    const rateLimitIdentity = { appId, host: hostname, username };\n    await runRateLimit('assertAllowed', rateLimitIdentity);\n    const mapped = await registry.findTenantByLoginHost(hostname, appId);
    if (!mapped || mapped.app_id !== appId || mapped.lifecycle_state !== 'active') {
      throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS', status: 401 });
    }
    const tenantContext = await resolveTenantContext({
      auth: { authenticated: true, appId, tenantId: mapped.tenant_uuid },
      appId, registry, secretProvider
    });
    const pool = await poolManager.getPool(tenantContext);
    const [rows] = await pool.execute(
      'SELECT id, username, password, real_name, role, mode FROM users WHERE username = ? AND mode = ? LIMIT 1',
      [username, appId]
    );
    const user = rows[0];
    let valid = false;
    if (user && typeof user.password === 'string') {
      try { valid = verifyPassword(password, user.password) === true; } catch (_) { valid = false; }
    }
    if (!valid) {\n      await runRateLimit('recordFailure', rateLimitIdentity);\n      throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS', status: 401 });\n    }
    if (!Number.isSafeInteger(Number(user.id)) || Number(user.id) < 1) {
      throw Object.assign(new Error('LOGIN_IDENTITY_INVALID'), { code: 'LOGIN_IDENTITY_INVALID', status: 503 });
    }

    const issuedAt = now();
    const expiresAt = issuedAt + lifetimeSeconds;
    const sessionId = crypto.randomUUID();
    const subjectId = String(user.id);
    const signing = await signingKeyProvider.getSigningKey({ appId });
    if (!signing || typeof signing.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(signing.kid) ||
        !(typeof signing.key === 'string' || Buffer.isBuffer(signing.key)) || Buffer.byteLength(signing.key) < 32) {
      throw Object.assign(new Error('AUTH_SIGNING_KEY_UNAVAILABLE'), { code: 'AUTH_SIGNING_KEY_UNAVAILABLE', status: 503 });
    }
    const header = encode({ alg: 'HS256', typ: 'JWT', kid: signing.kid });
    const claims = encode({
      iss: issuer, aud: appId, appId, sub: subjectId,
      tenantId: mapped.tenant_uuid, jti: sessionId, iat: issuedAt, exp: expiresAt
    });
    const unsigned = header + '.' + claims;
    const signature = crypto.createHmac('sha256', signing.key).update(unsigned).digest('base64url');
    await sessionStore.createSession({
      sessionId, userId: subjectId, tenantId: mapped.tenant_uuid, appId,
      issuedAt, expiresAt
    });
    return Object.freeze({
      accessToken: unsigned + '.' + signature,
      tokenType: 'Bearer',
      expiresIn: lifetimeSeconds,
      user: Object.freeze({
        id: subjectId, username: user.username,
        realName: typeof user.real_name === 'string' ? user.real_name : '',
        role: typeof user.role === 'string' ? user.role : 'staff'
      })
    });
  }

  async function logout(auth) {
    if (!auth || auth.authenticated !== true || auth.appId !== appId ||
        typeof auth.sessionId !== 'string' || typeof auth.userId !== 'string' ||
        typeof auth.tenantId !== 'string') {
      throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED', status: 401 });
    }
    await sessionStore.revokeSession({
      sessionId: auth.sessionId, userId: auth.userId, tenantId: auth.tenantId, appId
    });
    return { ok: true };
  }

  return Object.freeze({ login, logout });
}

module.exports = { normalizeLoginHost, createProductLoginService };
