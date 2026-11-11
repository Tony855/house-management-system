'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformAdminAuditStore } = require('../services/platform-api/admin-audit-store');

test('platform audit stores allowlisted metadata only and binds all SQL values', async () => {
  const calls = [];
  const store = createPlatformAdminAuditStore({
    query: async (sql, values) => { calls.push({ sql, values }); return [{ affectedRows: 1 }, []]; }
  });
  assert.equal(await store.append({
    adminId: 7, sessionId: 'session-id-1234567890',
    action: 'admin.mfa.verify', outcome: 'failure', code: 'PLATFORM_MFA_CODE_INVALID'
  }), true);
  assert.match(calls[0].sql, /INSERT INTO platform_admin_audit_events/);
  assert.deepEqual(calls[0].values, [7, 'session-id-1234567890', 'admin.mfa.verify', 'failure', 'PLATFORM_MFA_CODE_INVALID']);
});

test('platform audit rejects unbounded or secret-bearing event shapes', async () => {
  const store = createPlatformAdminAuditStore({ query: async () => [{ affectedRows: 1 }, []] });
  await assert.rejects(store.append({ action: 'admin.login', outcome: 'success', username: 'root' }), /PLATFORM_AUDIT_EVENT_INVALID/);
  await assert.rejects(store.append({ adminId: 0, action: 'admin.login', outcome: 'success' }), /PLATFORM_AUDIT_ADMIN_INVALID/);
  await assert.rejects(store.append({ action: 'admin.login', outcome: 'success', code: 'password=secret' }), /PLATFORM_AUDIT_CODE_INVALID/);
  await assert.rejects(store.append({ action: 'admin.unknown', outcome: 'success' }), /PLATFORM_AUDIT_EVENT_INVALID/);
});

test('audit storage failure is propagated so security-sensitive callers can fail closed', async () => {
  const store = createPlatformAdminAuditStore({ query: async () => { throw new Error('DB_DOWN'); } });
  await assert.rejects(store.append({ action: 'admin.logout', outcome: 'success' }), /DB_DOWN/);
});
