'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMariaDbTenantWriteAuditStore } = require('../server/tenant-write-audit-mariadb');

test('tenant write audit stores only allowlisted event metadata with bound SQL values', async () => {
  const calls = [];
  const store = createMariaDbTenantWriteAuditStore();
  const tx = { execute: async (sql, values) => { calls.push({ sql, values }); return [{ affectedRows: 1 }, []]; } };
  const event = {
    appId: 'rental', tenantId: '12345678-1234-4123-8123-123456789abc',
    userId: 'user-1', sessionId: 'session-1234567890',
    operation: 'create', reason: 'Create room for tenant',
    requestId: 'request-1234567890', event: 'tenant_write_started'
  };
  assert.equal(await store.append(tx, event), true);
  assert.match(calls[0].sql, /INSERT INTO tenant_write_audit_events/);
  assert.deepEqual(calls[0].values, [
    'rental', event.tenantId, 'user-1', 'session-1234567890',
    'create', 'Create room for tenant', 'request-1234567890', 'tenant_write_started'
  ]);
});

test('tenant write audit rejects arbitrary payloads and cross-app identities', async () => {
  const store = createMariaDbTenantWriteAuditStore();
  const tx = { execute: async () => [{ affectedRows: 1 }, []] };
  const base = {
    appId: 'rental', tenantId: '12345678-1234-4123-8123-123456789abc',
    userId: 'user-1', sessionId: 'session-1234567890',
    operation: 'create', reason: 'Create room for tenant',
    requestId: 'request-1234567890', event: 'tenant_write_started'
  };
  await assert.rejects(store.append(tx, { ...base, payload: { password: 'secret' } }), /TENANT_WRITE_AUDIT_EVENT_INVALID/);
  await assert.rejects(store.append(tx, { ...base, appId: 'platform' }), /TENANT_WRITE_AUDIT_EVENT_INVALID/);
  await assert.rejects(store.append(tx, { ...base, reason: 'short' }), /TENANT_WRITE_AUDIT_EVENT_INVALID/);
});
