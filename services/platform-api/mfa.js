'use strict';

const crypto = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;
const RECOVERY_CODE_COUNT = 10;
const ENROLLMENT_TTL_SECONDS = 600;

function fail(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

function encodeBase32(input) {
  const bytes = Buffer.from(input);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input) {
  if (typeof input !== 'string' || !/^[A-Z2-7]+$/.test(input)) fail('PLATFORM_MFA_SECRET_INVALID', 503);
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of input) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  if (!Number.isSafeInteger(counter) || counter < 0) fail('PLATFORM_MFA_COUNTER_INVALID', 500);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % (10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function verifyTotp(secret, code, nowSeconds = Math.floor(Date.now() / 1000), window = 1) {
  if (!Buffer.isBuffer(secret) || secret.length < 20 ||
      typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
      !Number.isInteger(window) || window < 0 || window > 1) return null;
  const current = Math.floor(nowSeconds / STEP_SECONDS);
  const supplied = Buffer.from(code);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (crypto.timingSafeEqual(supplied, expected)) return counter;
  }
  return null;
}

function hashRecoveryCode(code, pepper) {
  if (typeof code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ||
      !(typeof pepper === 'string' || Buffer.isBuffer(pepper)) || Buffer.byteLength(pepper) < 32) {
    fail('PLATFORM_MFA_RECOVERY_CODE_INVALID');
  }
  return crypto.createHmac('sha256', pepper).update(code).digest('hex');
}

function createPlatformMfaService({
  store, encryption, recoveryCodePepper,
  now = () => Math.floor(Date.now() / 1000),
  randomBytes = crypto.randomBytes
}) {
  const required = {
    getPendingEnrollment: 'getPendingEnrollment',
    savePendingEnrollment: 'savePendingEnrollment',
    getFactor: 'getFactor',
    activateFactor: 'activateFactor',
    consumeTotpCounter: 'consumeTotpCounter',
    consumeRecoveryCode: 'consumeRecoveryCode',
    replaceRecoveryCodes: 'replaceRecoveryCodes'
  };
  if (!store || Object.values(required).some(method => typeof store[method] !== 'function')) {
    throw new TypeError('PLATFORM_MFA_STORE_REQUIRED');
  }
  if (!encryption || typeof encryption.encrypt !== 'function' || typeof encryption.decrypt !== 'function') {
    throw new TypeError('PLATFORM_MFA_ENCRYPTION_REQUIRED');
  }
  if (!(typeof recoveryCodePepper === 'string' || Buffer.isBuffer(recoveryCodePepper)) ||
      Buffer.byteLength(recoveryCodePepper) < 32) throw new TypeError('PLATFORM_MFA_RECOVERY_PEPPER_REQUIRED');
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('PLATFORM_MFA_CLOCK_INVALID');

  async function decryptFactor(record) {
    const secret = await encryption.decrypt(record.encryptedSecret);
    if (!Buffer.isBuffer(secret) || secret.length < 20) fail('PLATFORM_MFA_SECRET_UNAVAILABLE', 503);
    return secret;
  }

  async function beginEnrollment({ adminId, issuer = 'House Management' , account }) {
    if (!Number.isSafeInteger(adminId) || adminId < 1 ||
        typeof account !== 'string' || !account || account.length > 160 ||
        typeof issuer !== 'string' || !issuer || issuer.length > 80) fail('PLATFORM_MFA_ENROLLMENT_INPUT_INVALID');
    const secret = randomBytes(20);
    if (!Buffer.isBuffer(secret) || secret.length !== 20) fail('PLATFORM_MFA_RANDOM_SOURCE_INVALID', 503);
    try {
      const encoded = encodeBase32(secret);
      const encryptedSecret = await encryption.encrypt(secret);
      if (!encryptedSecret || typeof encryptedSecret !== 'object') fail('PLATFORM_MFA_ENCRYPTION_FAILED', 503);
      await store.savePendingEnrollment({
        adminId, encryptedSecret, expiresAt: now() + ENROLLMENT_TTL_SECONDS
      });
      const label = encodeURIComponent(issuer + ':' + account);
      const query = new URLSearchParams({
        secret: encoded, issuer, algorithm: 'SHA1', digits: String(CODE_DIGITS), period: String(STEP_SECONDS)
      });
      return Object.freeze({ secret: encoded, otpauthUrl: 'otpauth://totp/' + label + '?' + query.toString() });
    } finally {
      secret.fill(0);
    }
  }

  async function confirmEnrollment({ adminId, code }) {
    if (!Number.isSafeInteger(adminId) || adminId < 1) fail('PLATFORM_MFA_ADMIN_INVALID', 403);
    const pending = await store.getPendingEnrollment(adminId);
    if (!pending || !Number.isSafeInteger(pending.expiresAt) || pending.expiresAt <= now()) {
      fail('PLATFORM_MFA_ENROLLMENT_EXPIRED', 410);
    }
    const secret = await encryption.decrypt(pending.encryptedSecret);
    try {
      const counter = verifyTotp(secret, code, now());
      if (counter === null) fail('PLATFORM_MFA_CODE_INVALID', 401);
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
        const raw = randomBytes(6).toString('hex').toUpperCase();
        return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
      });
      const recoveryCodeHashes = recoveryCodes.map(value => hashRecoveryCode(value, recoveryCodePepper));
      await store.activateFactor({ adminId, encryptedSecret: pending.encryptedSecret, lastTotpCounter: counter, recoveryCodeHashes });
      return Object.freeze({ enabled: true, recoveryCodes: Object.freeze(recoveryCodes) });
    } finally {
      if (Buffer.isBuffer(secret)) secret.fill(0);
    }
  }

  async function verify({ adminId, code }) {
    if (!Number.isSafeInteger(adminId) || adminId < 1) fail('PLATFORM_MFA_ADMIN_INVALID', 403);
    if (typeof code !== 'string' || code.length > 32) fail('PLATFORM_MFA_CODE_INVALID', 401);
    const factor = await store.getFactor(adminId);
    if (!factor || factor.enabled !== true) fail('PLATFORM_MFA_NOT_ENROLLED', 403);
    const secret = await decryptFactor(factor);
    try {
      const counter = verifyTotp(secret, code, now());
      if (counter !== null) {
        const consumed = await store.consumeTotpCounter({ adminId, counter });
        if (consumed !== true) fail('PLATFORM_MFA_CODE_REPLAYED', 401);
        return Object.freeze({ verified: true, method: 'totp', verifiedAt: now() });
      }
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        const consumed = await store.consumeRecoveryCode({
          adminId, codeHash: hashRecoveryCode(code, recoveryCodePepper)
        });
        if (consumed === true) return Object.freeze({ verified: true, method: 'recovery', verifiedAt: now() });
      }
      fail('PLATFORM_MFA_CODE_INVALID', 401);
    } finally {
      secret.fill(0);
    }
  }


  async function getStatus({ adminId }) {
    if (!Number.isSafeInteger(adminId) || adminId < 1) fail('PLATFORM_MFA_ADMIN_INVALID', 403);
    const factor = await store.getFactor(adminId);
    return Object.freeze({ enabled: !!factor && factor.enabled === true });
  }

  async function rotateRecoveryCodes({ adminId, code }) {
    const verified = await verify({ adminId, code });
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = randomBytes(6).toString('hex').toUpperCase();
      return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
    });
    const recoveryCodeHashes = recoveryCodes.map(value => hashRecoveryCode(value, recoveryCodePepper));
    const replaced = await store.replaceRecoveryCodes({ adminId, recoveryCodeHashes });
    if (replaced !== true) fail('PLATFORM_MFA_RECOVERY_ROTATION_FAILED', 503);
    return Object.freeze({ rotated: true, method: verified.method, recoveryCodes: Object.freeze(recoveryCodes) });
  }

  return Object.freeze({ beginEnrollment, confirmEnrollment, verify, getStatus, rotateRecoveryCodes });
}

module.exports = {
  STEP_SECONDS, CODE_DIGITS, RECOVERY_CODE_COUNT, ENROLLMENT_TTL_SECONDS,
  encodeBase32, decodeBase32, hotp, verifyTotp, hashRecoveryCode, createPlatformMfaService
};
