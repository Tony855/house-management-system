'use strict';

const APP_IDS = new Set(['rental', 'hotel', 'property']);
const EVENTS = new Set(['tenant_write_started', 'tenant_write_replayed', 'tenant_write_committed']);
const SYSTEM_EVENTS = new Set(['tenant_system_write_started', 'tenant_system_write_replayed', 'tenant_system_write_committed']);
const OPERATIONS = new Set(['create', 'update', 'delete']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const WORKER_RE = /^[A-Za-z0-9._:-]{1,100}$/;

function createMariaDbTenantWriteAuditStore() {
  return Object.freeze({
    async append(tx, event) {
      const allowedKeys = new Set(['appId', 'tenantId', 'userId', 'sessionId', 'operation', 'reason', 'requestId', 'event']);
      if (!event || typeof event !== 'object' || Object.keys(event).some(key => !allowedKeys.has(key)) ||
          !tx || typeof tx.execute !== 'function' || !APP_IDS.has(event.appId) ||
          !UUID_RE.test(event.tenantId || '') || typeof event.userId !== 'string' || !event.userId ||
          event.userId.length > 128 || typeof event.sessionId !== 'string' ||
          !/^[A-Za-z0-9._~-]{16,128}$/.test(event.sessionId) || !OPERATIONS.has(event.operation) ||
          typeof event.reason !== 'string' || event.reason.length < 8 || event.reason.length > 500 ||
          /[\x00-\x1f\x7f]/.test(event.reason) || !REQUEST_ID_RE.test(event.requestId || '') ||
          !EVENTS.has(event.event)) throw new TypeError('TENANT_WRITE_AUDIT_EVENT_INVALID');
      await tx.execute(
        'INSERT INTO tenant_write_audit_events (app_id, tenant_uuid, actor_type, user_id, session_id, operation, reason, request_id, event_type) VALUES (?, ?, \'user\', ?, ?, ?, ?, ?, ?)',
        [event.appId, event.tenantId, event.userId, event.sessionId, event.operation, event.reason, event.requestId, event.event]
      );
      return true;
    },
    async appendSystem(tx, event) {
      const allowedKeys = new Set(['appId', 'tenantId', 'workerId', 'operation', 'reason', 'requestId', 'event']);
      if (!event || typeof event !== 'object' || Object.keys(event).some(key => !allowedKeys.has(key)) ||
          !tx || typeof tx.execute !== 'function' || !APP_IDS.has(event.appId) ||
          !UUID_RE.test(event.tenantId || '') || !WORKER_RE.test(event.workerId || '') ||
          !OPERATIONS.has(event.operation) || typeof event.reason !== 'string' ||
          event.reason.length < 8 || event.reason.length > 500 || /[\x00-\x1f\x7f]/.test(event.reason) ||
          !REQUEST_ID_RE.test(event.requestId || '') || !SYSTEM_EVENTS.has(event.event)) {
        throw new TypeError('TENANT_SYSTEM_WRITE_AUDIT_EVENT_INVALID');
      }
      await tx.execute(
        'INSERT INTO tenant_write_audit_events (app_id, tenant_uuid, actor_type, system_id, user_id, session_id, operation, reason, request_id, event_type) VALUES (?, ?, \'system\', ?, ?, ?, ?, ?, ?, ?)',
        [event.appId, event.tenantId, event.workerId, 'system:' + event.workerId, 'worker:' + event.workerId,
          event.operation, event.reason, event.requestId, event.event]
      );
      return true;
    }
  });
}

module.exports = { EVENTS, SYSTEM_EVENTS, createMariaDbTenantWriteAuditStore };
