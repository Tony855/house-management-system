'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformAdminMfaStore, parseEnvelope } = require('../services/platform-api/mfa-store');

test('MFA store persists only encrypted envelopes and returns parsed records', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.startsWith('SELECT encrypted_secret, UNIX_TIMESTAMP')) {
        return [[{ encrypted_secret: JSON.stringify({ ciphertext: 'opaque' }), expires_at: 1800000600 }], []];
      }
      if (sql.startsWith('SELECT encrypted_secret, enabled')) {
        return [[{ encrypted_secret: { ciphertext: 'opaque' }, enabled: 1, last_totp_counter: '60000000' }], []];
      }
      return [{ affectedRows: 1 }, []];
    },
    getConnection: async () => {
      const tx = [];
      return {
        tx,
        beginTransaction: async () => tx.push('begin'),
        query: async (sql, params) => { tx.push([sql, params]); return [{ affectedRows: 1 }, []]; },
        commit: async () => tx.push('commit'),
        rollback: async () => tx.push('rollback'),
        release: () => tx.push('release')
      };
    }
  };
  const store = createPlatformAdminMfaStore(pool);
  await store.savePendingEnrollment({
    adminId: 4, encryptedSecret: { ciphertext: 'cipher-only' }, expiresAt: 1800000600
  });
  assert.equal(calls[0][1][1], JSON.stringify({ ciphertext: 'cipher-only' }));
  assert.deepEqual(await store.getPendingEnrollment(4), {
    encryptedSecret: { ciphertext: 'opaque' }, expiresAt: 1800000600
  });
  assert.deepEqual(await store.getFactor(4), {
    encryptedSecret: { ciphertext: 'opaque' }, enabled: true, lastTotpCounter: 60000000
  });
  assert.equal(await store.consumeTotpCounter({ adminId: 4, counter: 60000001 }), true);
  assert.equal(await store.consumeRecoveryCode({ adminId: 4, codeHash: 'a'.repeat(64) }), true);
});

test('factor activation writes factor, replaces recovery codes and clears pending enrollment transactionally', async () => {
  let connection;
  const pool = {
    query: async () => [{ affectedRows: 1 }, []],
    getConnection: async () => (connection = {
      calls: [],
      beginTransaction: async () => connection.calls.push('begin'),
      query: async sql => { connection.calls.push(sql); if (sql.startsWith('SELECT encrypted_secret FROM platform_admin_mfa_enrollments')) return [[{ encrypted_secret: { ciphertext: 'encrypted' } }], []]; return [{ affectedRows: 1 }, []]; },
      commit: async () => connection.calls.push('commit'),
      rollback: async () => connection.calls.push('rollback'),
      release: () => connection.calls.push('release')
    })
  };
  const store = createPlatformAdminMfaStore(pool);
  await store.activateFactor({
    adminId: 4, encryptedSecret: { ciphertext: 'encrypted' },
    lastTotpCounter: 60000000, recoveryCodeHashes: Array.from({ length: 10 }, (_, i) => String(i).padStart(64, 'a'))
  });
  assert.equal(connection.calls[0], 'begin');
  assert.match(connection.calls[1], /^SELECT encrypted_secret FROM platform_admin_mfa_enrollments/);
  assert.match(connection.calls[2], /^INSERT INTO platform_admin_mfa_factors/);
  assert.match(connection.calls[3], /^DELETE FROM platform_admin_mfa_recovery_codes/);
  assert.equal(connection.calls.filter(value => typeof value === 'string' && /^(INSERT|DELETE)/.test(value)).length, 13);
  assert.equal(connection.calls.at(-2), 'commit');
  assert.equal(connection.calls.at(-1), 'release');
});

test('MFA store fails closed on invalid envelopes and malformed inputs', async () => {
  assert.throws(() => parseEnvelope('not-json'), /PLATFORM_MFA_ENVELOPE_INVALID/);
  assert.throws(() => createPlatformAdminMfaStore({ query() {} }), /PLATFORM_MFA_DATABASE_POOL_REQUIRED/);
  const store = createPlatformAdminMfaStore({ query: async () => [[], []], getConnection: async () => ({}) });
  assert.equal(await store.getFactor(0), null);
  assert.equal(await store.getPendingEnrollment(-1), null);
  assert.equal(await store.consumeTotpCounter({ adminId: 1, counter: -1 }), false);
  assert.equal(await store.consumeRecoveryCode({ adminId: 1, codeHash: 'bad' }), false);
});

test('MFA activation fails closed if another request already consumed or replaced enrollment', async () => {
  let calls = [];
  const pool = {
    query: async () => [[], []],
    getConnection: async () => ({
      beginTransaction: async () => calls.push('begin'),
      query: async sql => { calls.push(sql); return [[], []]; },
      commit: async () => calls.push('commit'),
      rollback: async () => calls.push('rollback'),
      release: () => calls.push('release')
    })
  };
  const store = createPlatformAdminMfaStore(pool);
  await assert.rejects(store.activateFactor({
    adminId: 4, encryptedSecret: { ciphertext: 'old-enrollment' },
    lastTotpCounter: 60000000, recoveryCodeHashes: Array.from({ length: 10 }, () => 'a'.repeat(64))
  }), error => error.code === 'PLATFORM_MFA_ENROLLMENT_CONFLICT' && error.status === 409);
  assert.deepEqual(calls, [
    'begin',
    'SELECT encrypted_secret FROM platform_admin_mfa_enrollments WHERE admin_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE',
    'rollback',
    'release'
  ]);
});
