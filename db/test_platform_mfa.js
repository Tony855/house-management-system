'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const {
  encodeBase32, decodeBase32, hotp, verifyTotp, hashRecoveryCode, createPlatformMfaService
} = require('../services/platform-api/mfa');

const pepper = 'recovery-code-pepper-material-at-least-32-bytes';

test('base32 codec and HOTP match RFC 4226 vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(encodeBase32(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(decodeBase32(encodeBase32(secret)), secret);
  assert.equal(hotp(secret, 0), '755224');
  assert.equal(hotp(secret, 1), '287082');
  assert.equal(hotp(secret, 2), '359152');
});

test('TOTP accepts only the bounded current time window and valid six-digit codes', () => {
  const secret = Buffer.from('12345678901234567890');
  const now = 1800000000;
  const counter = Math.floor(now / 30);
  assert.equal(verifyTotp(secret, hotp(secret, counter), now), counter);
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
  assert.equal(verifyTotp(secret, hotp(secret, counter + 2), now), null);
  assert.equal(verifyTotp(Buffer.alloc(4), hotp(secret, counter), now), null);
});

test('recovery code hashes are keyed and never store plaintext', () => {
  const code = 'A1B2-C3D4-E5F6';
  const hash = hashRecoveryCode(code, pepper);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, code);
  assert.notEqual(hash, hashRecoveryCode(code, 'different-pepper-material-at-least-32-bytes'));
  assert.throws(() => hashRecoveryCode(code, 'short'), /PLATFORM_MFA_RECOVERY_CODE_INVALID/);
});

function fixture() {
  let currentTime = 1800000000;
  const state = { pending: null, factor: null, recovery: new Set() };
  const store = {
    savePendingEnrollment: async value => { state.pending = value; },
    getPendingEnrollment: async () => state.pending,
    activateFactor: async value => {
      state.factor = { encryptedSecret: value.encryptedSecret, enabled: true, lastTotpCounter: value.lastTotpCounter };
      state.recovery = new Set(value.recoveryCodeHashes);
      state.pending = null;
    },
    getFactor: async () => state.factor,
    consumeTotpCounter: async ({ counter }) => {
      if (!state.factor || counter <= state.factor.lastTotpCounter) return false;
      state.factor.lastTotpCounter = counter;
      return true;
    },
    consumeRecoveryCode: async ({ codeHash }) => {
      if (!state.recovery.has(codeHash)) return false;
      state.recovery.delete(codeHash);
      return true;
    },
    replaceRecoveryCodes: async ({ recoveryCodeHashes }) => {
      if (!state.factor) return false;
      state.recovery = new Set(recoveryCodeHashes);
      return true;
    }
  };
  const encryption = {
    encrypt: async secret => ({ ciphertext: secret.toString('base64') }),
    decrypt: async envelope => Buffer.from(envelope.ciphertext, 'base64')
  };
  const service = createPlatformMfaService({
    store, encryption, recoveryCodePepper: pepper, now: () => currentTime
  });
  return { service, state, setTime: value => { currentTime = value; } };
}

test('enrollment is pending until valid TOTP confirmation and returns one-time recovery codes', async () => {
  const { service, state } = fixture();
  const enrollment = await service.beginEnrollment({ adminId: 9, account: 'admin@example.test' });
  assert.match(enrollment.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal(state.factor, null);
  const secret = decodeBase32(enrollment.secret);
  const result = await service.confirmEnrollment({ adminId: 9, code: hotp(secret, Math.floor(1800000000 / 30)) });
  assert.equal(result.enabled, true);
  assert.equal(result.recoveryCodes.length, 10);
  assert.equal(state.pending, null);
  assert.equal(state.recovery.size, 10);
  assert.equal(state.factor.lastTotpCounter, Math.floor(1800000000 / 30));
});

test('TOTP verification rejects replayed counters and recovery codes are single-use', async () => {
  const { service, state, setTime } = fixture();
  const enrollment = await service.beginEnrollment({ adminId: 9, account: 'admin@example.test' });
  const secret = decodeBase32(enrollment.secret);
  const firstCounter = Math.floor(1800000000 / 30);
  const enrolled = await service.confirmEnrollment({ adminId: 9, code: hotp(secret, firstCounter) });
  await assert.rejects(service.verify({ adminId: 9, code: hotp(secret, firstCounter) }),
    error => error.code === 'PLATFORM_MFA_CODE_REPLAYED');
  setTime((firstCounter + 1) * 30);
  const verified = await service.verify({ adminId: 9, code: hotp(secret, firstCounter + 1) });
  assert.deepEqual(verified, { verified: true, method: 'totp', verifiedAt: (firstCounter + 1) * 30 });
  const recovery = enrolled.recoveryCodes[0];
  assert.equal((await service.verify({ adminId: 9, code: recovery })).method, 'recovery');
  await assert.rejects(service.verify({ adminId: 9, code: recovery }),
    error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  assert.equal(state.recovery.size, 9);
});

test('MFA status is non-secret and recovery rotation verifies a current factor and invalidates old codes', async () => {
  const { service, state, setTime } = fixture();
  const enrollment = await service.beginEnrollment({ adminId: 9, account: 'admin@example.test' });
  const secret = decodeBase32(enrollment.secret);
  const counter = Math.floor(1800000000 / 30);
  const enrolled = await service.confirmEnrollment({ adminId: 9, code: hotp(secret, counter) });
  assert.deepEqual(await service.getStatus({ adminId: 9 }), { enabled: true });
  setTime((counter + 1) * 30);
  const rotated = await service.rotateRecoveryCodes({
    adminId: 9, code: hotp(secret, counter + 1)
  });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.method, 'totp');
  assert.equal(rotated.recoveryCodes.length, 10);
  assert.equal(state.recovery.size, 10);
  await assert.rejects(service.verify({ adminId: 9, code: enrolled.recoveryCodes[0] }),
    error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  assert.equal((await service.verify({ adminId: 9, code: rotated.recoveryCodes[0] })).method, 'recovery');
});

test('expired or invalid enrollment cannot activate a factor', async () => {
  const { service, state, setTime } = fixture();
  const enrollment = await service.beginEnrollment({ adminId: 9, account: 'admin@example.test' });
  await assert.rejects(service.confirmEnrollment({ adminId: 9, code: '000000' }),
    error => error.code === 'PLATFORM_MFA_CODE_INVALID');
  assert.equal(state.factor, null);
  setTime(1800000000 + 601);
  await assert.rejects(service.confirmEnrollment({ adminId: 9, code: '000000' }),
    error => error.code === 'PLATFORM_MFA_ENROLLMENT_EXPIRED');
  assert.equal(enrollment.secret.length > 0, true);
});

test('MFA service requires encrypted storage, durable store and a strong recovery pepper', () => {
  assert.throws(() => createPlatformMfaService({}), /PLATFORM_MFA_STORE_REQUIRED/);
  const store = {
    getPendingEnrollment() {}, savePendingEnrollment() {}, getFactor() {},
    activateFactor() {}, consumeTotpCounter() {}, consumeRecoveryCode() {}, replaceRecoveryCodes() {}
  };
  assert.throws(() => createPlatformMfaService({ store, encryption: {}, recoveryCodePepper: pepper }), /PLATFORM_MFA_ENCRYPTION_REQUIRED/);
  assert.throws(() => createPlatformMfaService({ store, encryption: { encrypt() {}, decrypt() {} }, recoveryCodePepper: 'short' }), /PLATFORM_MFA_RECOVERY_PEPPER_REQUIRED/);
});


test('MFA enrollment cannot silently replace an already active authenticator', async () => {
  const { service, state } = fixture();
  const enrollment = await service.beginEnrollment({ adminId: 9, account: 'admin@example.test' });
  const secret = decodeBase32(enrollment.secret);
  const counter = Math.floor(1800000000 / 30);
  await service.confirmEnrollment({ adminId: 9, code: hotp(secret, counter) });
  await assert.rejects(
    service.beginEnrollment({ adminId: 9, account: 'admin@example.test' }),
    error => error.code === 'PLATFORM_MFA_ALREADY_ENROLLED' && error.status === 409
  );
  assert.equal(state.factor.enabled, true);
  assert.equal(state.pending, null);
});
