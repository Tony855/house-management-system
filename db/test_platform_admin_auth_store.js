'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformAdminAuthStore } = require('../services/platform-api/admin-auth-store');

test('platform admin lookup returns only authentication metadata and parsed permissions', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.includes('WHERE username')) return [[{
      id: 7, password_hash: 'salt:hash', status: 'active', mfa_required: 1,
      permissions_json: '["platform:read","plans:write"]'
    }], []];
    return [[{ id: 7, status: 'active', mfa_required: 1, permissions_json: ['platform:read'] }], []];
  } };
  const store = createPlatformAdminAuthStore(pool);
  assert.deepEqual(await store.findByUsername('root'), {
    id: 7, passwordHash: 'salt:hash', status: 'active', mfaRequired: true,
    permissions: ['platform:read', 'plans:write']
  });
  assert.deepEqual(await store.findById(7), {
    id: 7, status: 'active', mfaRequired: true, permissions: ['platform:read']
  });
  assert.deepEqual(calls[0][1], ['root']);
});

test('challenge and session writes validate input and use one-time conditional SQL updates', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql.startsWith('SELECT admin_id')) return [[{
      admin_id: 7, expires_at: 1800000180, consumed_at: null, attempts: 2
    }], []];
    return [{ affectedRows: 1 }, []];
  } };
  const store = createPlatformAdminAuthStore(pool);
  await store.createChallenge({ challengeHash: 'a'.repeat(64), adminId: 7, expiresAt: 1800000180 });
  assert.equal((await store.getChallenge('a'.repeat(64))).attempts, 2);
  assert.equal(await store.recordChallengeFailure({ challengeHash: 'a'.repeat(64), adminId: 7 }), true);
  assert.match(calls[2][0], /attempts = attempts \+ 1/);
  assert.equal(await store.consumeChallenge({ challengeHash: 'a'.repeat(64), adminId: 7 }), true);
  assert.match(calls[3][0], /consumed_at = UTC_TIMESTAMP\(\)/);
  await store.createSession({
    sessionId: 's'.repeat(43), adminId: 7, issuedAt: 1800000000,
    expiresAt: 1800000900, mfaVerifiedAt: 1800000000, permissions: ['platform:read']
  });
  assert.match(calls[4][0], /^INSERT INTO platform_admin_sessions/);
  assert.equal(await store.touchMfaVerified({ adminId: 7, sessionId: 's'.repeat(43), verifiedAt: 1800000010 }), true);
  assert.equal(await store.touchStepUpVerified({ adminId: 7, sessionId: 's'.repeat(43), verifiedAt: 1800000020 }), true);
  assert.match(calls[6][0], /last_step_up_at/);
  assert.equal(await store.revokeSession({ adminId: 7, sessionId: 's'.repeat(43) }), true);
});

test('challenge and session adapters reject malformed IDs and hashes', async () => {
  const store = createPlatformAdminAuthStore({ query: async () => [{ affectedRows: 0 }, []] });
  await assert.rejects(store.createChallenge({ challengeHash: 'bad', adminId: 1, expiresAt: 2 }), /PLATFORM_MFA_CHALLENGE_INVALID/);
  assert.equal(await store.getChallenge('bad'), null);
  assert.equal(await store.consumeChallenge({ challengeHash: 'bad', adminId: 1 }), false);
  assert.equal(await store.recordChallengeFailure({ challengeHash: 'bad', adminId: 1 }), false);
  assert.equal(await store.findById(0), null);
  assert.equal(await store.touchMfaVerified({ adminId: 1, sessionId: '', verifiedAt: 2 }), false);
});

test('admin disable locks active admins and atomically revokes all target sessions', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.includes('SELECT id FROM platform_admins')) return [[{ id: 7 }, { id: 8 }], []];
      return [{ affectedRows: 1 }, []];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  const store = createPlatformAdminAuthStore({ query: async () => [[], []], getConnection: async () => connection });
  assert.equal(await store.disableAdmin({ actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890' }), true);
  assert.match(calls[1][0], /FOR UPDATE/);
  assert.match(calls[2][0], /status = 'disabled'/);
  assert.match(calls[3][0], /UPDATE platform_admin_sessions SET revoked_at/);
  assert.match(calls[4][0], /INSERT INTO platform_admin_audit_events/);
  assert.deepEqual(calls[4][1], [7, 'session-id-1234567890', 'admin.disable', 'success', 'TARGET_ADMIN_8']);
  assert.equal(calls.includes('commit'), true);
  assert.equal(calls.includes('release'), true);
});

test('admin disable refuses self-disable and last active administrator', async () => {
  let connections = 0;
  const connection = {
    beginTransaction: async () => {},
    query: async sql => sql.includes('SELECT id FROM platform_admins') ? [[{ id: 7 }], []] : [{ affectedRows: 0 }, []],
    commit: async () => {}, rollback: async () => {}, release: () => {}
  };
  const store = createPlatformAdminAuthStore({ query: async () => [[], []], getConnection: async () => { connections++; return connection; } });
  assert.equal(await store.disableAdmin({ actorAdminId: 7, targetAdminId: 7 }), false);
  assert.equal(connections, 0);
  assert.equal(await store.disableAdmin({ actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890' }), false);
});


test('MFA reset disables the factor, deletes pending and recovery credentials, revokes sessions and audits atomically', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.startsWith('SELECT id FROM platform_admins')) return [[{ id: 8 }], []];
      return [{ affectedRows: 1 }, []];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  const store = createPlatformAdminAuthStore({
    query: async () => [[], []], getConnection: async () => connection
  });
  assert.equal(await store.resetAdminMfa({
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890',
    reason: 'Administrator lost enrolled authenticator'
  }), true);
  assert.match(calls[1][0], /status = 'active' FOR UPDATE/);
  assert.match(calls[2][0], /UPDATE platform_admin_mfa_factors SET enabled = 0/);
  assert.match(calls[3][0], /DELETE FROM platform_admin_mfa_recovery_codes/);
  assert.match(calls[4][0], /DELETE FROM platform_admin_mfa_enrollments/);
  assert.match(calls[5][0], /UPDATE platform_admin_sessions SET revoked_at/);
  assert.deepEqual(calls[6][1], [
    7, 'session-id-1234567890', 'admin.mfa.reset', 'success', 'TARGET_ADMIN_8'
  ]);
  assert.equal(calls.at(-2), 'commit');
  assert.equal(calls.at(-1), 'release');
});

test('MFA reset rejects self-reset, invalid reason and inactive target before changing records', async () => {
  let connections = 0;
  const store = createPlatformAdminAuthStore({
    query: async () => [[], []],
    getConnection: async () => {
      connections++;
      return {
        beginTransaction: async () => {},
        query: async () => [[], []],
        commit: async () => {},
        rollback: async () => {},
        release: () => {}
      };
    }
  });
  assert.equal(await store.resetAdminMfa({
    actorAdminId: 7, targetAdminId: 7, sessionId: 'session-id-1234567890', reason: 'valid reason'
  }), false);
  assert.equal(await store.resetAdminMfa({
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890', reason: 'short'
  }), false);
  assert.equal(connections, 0);
  assert.equal(await store.resetAdminMfa({
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890', reason: 'valid reset reason'
  }), false);
});


test('MFA reset rolls back factor, recovery, enrollment and session changes if audit persistence fails', async () => {
  const calls = [];
  const failure = new Error('audit unavailable');
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async (sql) => {
      calls.push(sql);
      if (sql.startsWith('SELECT id FROM platform_admins')) return [[{ id: 8 }], []];
      if (sql.startsWith('INSERT INTO platform_admin_audit_events')) throw failure;
      return [{ affectedRows: 1 }, []];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  const store = createPlatformAdminAuthStore({
    query: async () => [[], []], getConnection: async () => connection
  });
  await assert.rejects(store.resetAdminMfa({
    actorAdminId: 7, targetAdminId: 8, sessionId: 'session-id-1234567890',
    reason: 'Lost authenticator device'
  }), error => error === failure);
  assert.equal(calls.includes('rollback'), true);
  assert.equal(calls.includes('commit'), false);
  assert.equal(calls.at(-1), 'release');
});
