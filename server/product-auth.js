'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProductAuthError extends Error {
  constructor(code = 'AUTH_REQUIRED', status = 401) {
    super(code);
    this.name = 'ProductAuthError';
    this.code = code;
    this.status = status;
  }
}

function decodePart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ProductAuthError('TOKEN_INVALID');
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!decoded.length || decoded.toString('base64url') !== value) throw new Error('invalid base64url');
    return decoded;
  } catch (_) {
    throw new ProductAuthError('TOKEN_INVALID');
  }
}

function parseJsonPart(value) {
  try { return JSON.parse(decodePart(value).toString('utf8')); }
  catch (error) {
    if (error instanceof ProductAuthError) throw error;
    throw new ProductAuthError('TOKEN_INVALID');
  }
}

/**
 * HS256 access-token authenticator for an isolated product API.
 * Key rotation and session revocation are delegated to explicit adapters.
 */
function createProductAuthenticator({
  appId,
  issuer,
  keyProvider,
  sessionStore,
  now = () => Math.floor(Date.now() / 1000),
  clockSkewSeconds = 30,
  maxLifetimeSeconds = 900
}) {
  if (!['rental', 'hotel', 'property'].includes(appId)) throw new TypeError('PRODUCT_AUTH_APP_ID_INVALID');
  if (typeof issuer !== 'string' || !issuer) throw new TypeError('PRODUCT_AUTH_ISSUER_REQUIRED');
  if (!keyProvider || typeof keyProvider.getVerificationKey !== 'function') throw new TypeError('PRODUCT_AUTH_KEY_PROVIDER_REQUIRED');
  if (!sessionStore || typeof sessionStore.isSessionActive !== 'function') throw new TypeError('PRODUCT_AUTH_SESSION_STORE_REQUIRED');
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) throw new TypeError('PRODUCT_AUTH_CLOCK_SKEW_INVALID');
  if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 60 || maxLifetimeSeconds > 3600) throw new TypeError('PRODUCT_AUTH_MAX_LIFETIME_INVALID');

  return async function authenticateProductRequest(req, _res, next) {
    try {
      const header = req.headers.authorization;
      // Product access tokens are compact JWTs; bound parsing and HMAC work
      // before splitting or decoding attacker-controlled bearer input.
      if (typeof header !== 'string' || header.length > 8192 ||
          !/^Bearer [A-Za-z0-9._~-]+$/.test(header)) {
        throw new ProductAuthError('AUTH_REQUIRED');
      }
      const token = header.slice(7);
      const parts = token.split('.');
      if (parts.length !== 3) throw new ProductAuthError('TOKEN_INVALID');

      const protectedHeader = parseJsonPart(parts[0]);
      const claims = parseJsonPart(parts[1]);
      if (!protectedHeader || protectedHeader.alg !== 'HS256' || protectedHeader.typ !== 'JWT' ||
          Object.keys(protectedHeader).some(name => !['alg', 'typ', 'kid'].includes(name)) ||
          typeof protectedHeader.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(protectedHeader.kid)) {
        throw new ProductAuthError('TOKEN_INVALID');
      }

      const key = await keyProvider.getVerificationKey({ kid: protectedHeader.kid, appId });
      if (!(typeof key === 'string' || Buffer.isBuffer(key)) || Buffer.byteLength(key) < 32) {
        throw new ProductAuthError('AUTH_KEY_UNAVAILABLE', 503);
      }
      const expected = crypto.createHmac('sha256', key).update(parts[0] + '.' + parts[1]).digest();
      const supplied = decodePart(parts[2]);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        throw new ProductAuthError('TOKEN_INVALID');
      }

      const current = now();
      if (!claims || claims.iss !== issuer ||
          claims.aud !== appId ||
          claims.appId !== appId) throw new ProductAuthError('TOKEN_AUDIENCE_INVALID', 403);
      if (typeof claims.sub !== 'string' || !claims.sub ||
          typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 128 ||
          typeof claims.tenantId !== 'string' || !UUID_RE.test(claims.tenantId) ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.exp <= current || claims.iat > current + clockSkewSeconds ||
          claims.exp <= claims.iat || claims.exp - claims.iat > maxLifetimeSeconds ||
          (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > current + clockSkewSeconds))) {
        throw new ProductAuthError('TOKEN_INVALID');
      }

      const active = await sessionStore.isSessionActive({
        sessionId: claims.jti,
        userId: claims.sub,
        tenantId: claims.tenantId,
        appId
      });
      if (active !== true) throw new ProductAuthError('SESSION_REVOKED');

      req.auth = Object.freeze({
        authenticated: true,
        appId,
        tenantId: claims.tenantId,
        userId: claims.sub,
        sessionId: claims.jti,
        issuedAt: claims.iat,
        expiresAt: claims.exp
      });
      return next();
    } catch (error) {
      if (error instanceof ProductAuthError) return next(error);
      return next(new ProductAuthError('AUTHENTICATION_UNAVAILABLE', 503));
    }
  };
}

module.exports = { ProductAuthError, createProductAuthenticator };
