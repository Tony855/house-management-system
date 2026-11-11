'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { bootstrapFirstPlatformAdmin, LOCK_NAME } = require('../scripts/bootstrap-platform-admin');

function fixture({ existing = 0, failAt = '' } = {}) {
  const calls = [];
  const state = { admins: existing, committed: false, rolledBack: false, released: false };
  const connection = {
    query: async (sql, params = []) => {
      calls.push([sql, params]);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.includes('COUNT(*)')) return [[{ total: state.admins }], []];
      if (sql.startsWith('INSERT INTO platform_admins')) {
        if (failAt === 'admin') throw new Error('ADMIN_INSERT_FAILED');
        state.admins++;
        return [{ insertId: 91 }, []];
      }
      if (sql.includes('platform_admin_mfa_factors') && failAt === 'factor') throw new Error('FACTOR_INSERT_FAILED');
      if (sql.includes('platform_admin_mfa_recovery_codes') && failAt === 'recovery') throw new Error('RECOVERY_INSERT_FAILED');
      return [{ affectedRows: 1 }, []];
    },
    beginTransaction: async () => calls.push(['BEGIN']),
    commit: async () => { state.committed = true; calls.push(['COMMIT']); },
    rollback: async () => { state.rolledBack = true; state.admins = existing; calls.push(['ROLLBACK']); },
    release: () => { state.released = true; }
  };
  return {
    calls, state,
    pool: { getConnection: async () => connection },
    encryption: { encrypt: async secret => ({ ciphertext: secret.toString('base64'), keyId: 'test' }) }
  };
}

test('first admin bootstrap atomically creates MFA factor, one-time recovery codes and audit event', async () => {
  const f = fixture();
  const result = await bootstrapFirstPlatformAdmin({
    pool: f.pool, username: 'root', password: 'a-very-long-password-123',
    mfaEncryption: f.encryption, recoveryCodePepper: 'p'.repeat(32),
    now: () => 1800000000
  });
  assert.equal(result.adminId, 91);
  assert.equal(result.recoveryCodes.length, 10);
  assert.match(result.totpSecret, /^[A-Z2-7]+$/);
  assert.equal(f.state.committed, true);
  assert.equal(f.state.rolledBack, false);
  assert.equal(f.state.released, true);
  assert.ok(f.calls.some(([sql]) => sql.includes('GET_LOCK')));
  assert.ok(f.calls.some(([sql]) => sql.includes('platform_admin_mfa_factors')));
  assert.ok(f.calls.some(([sql]) => sql.includes('platform_admin_audit_events')));
  assert.ok(f.calls.some(([sql, params]) => sql.includes('RELEASE_LOCK') && params[0] === LOCK_NAME));
  assert.equal(f.calls.some(([sql, params]) => sql.includes('platform_admin_mfa_recovery_codes') && params.includes(result.recoveryCodes[0])), false);
});

test('first admin bootstrap refuses a second administrator and releases its lock', async () => {
  const f = fixture({ existing: 1 });
  await assert.rejects(bootstrapFirstPlatformAdmin({
    pool: f.pool, username: 'root', password: 'a-very-long-password-123',
    mfaEncryption: f.encryption, recoveryCodePepper: 'p'.repeat(32)
  }), error => error.code === 'PLATFORM_BOOTSTRAP_ALREADY_COMPLETED');
  assert.equal(f.state.committed, false);
  assert.equal(f.state.rolledBack, true);
  assert.equal(f.state.released, true);
});

test('first admin bootstrap rolls back all writes when a security record fails', async () => {
  const f = fixture({ failAt: 'factor' });
  await assert.rejects(bootstrapFirstPlatformAdmin({
    pool: f.pool, username: 'root', password: 'a-very-long-password-123',
    mfaEncryption: f.encryption, recoveryCodePepper: 'p'.repeat(32)
  }), /FACTOR_INSERT_FAILED/);
  assert.equal(f.state.committed, false);
  assert.equal(f.state.rolledBack, true);
  assert.equal(f.state.admins, 0);
});

test('first admin bootstrap rejects weak credentials and missing security providers before connecting', async () => {
  let connections = 0;
  await assert.rejects(bootstrapFirstPlatformAdmin({
    pool: { getConnection: async () => { connections++; } },
    username: 'x', password: 'short',
    mfaEncryption: {}, recoveryCodePepper: 'tiny'
  }), /PLATFORM_BOOTSTRAP_USERNAME_INVALID/);
  assert.equal(connections, 0);
});
