'use strict';

const ACTIONS = new Set([
  'admin.login', 'admin.mfa.verify', 'admin.mfa.enrollment.begin',
  'admin.mfa.enrollment.confirm', 'admin.mfa.recovery.rotate',
  'admin.step_up', 'admin.logout', 'admin.disable'
]);
const OUTCOMES = new Set(['success', 'failure']);

function createPlatformAdminAuditStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PLATFORM_AUDIT_POOL_REQUIRED');
  return Object.freeze({
    async append(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event) ||
          Object.keys(event).some(key => !['adminId', 'sessionId', 'action', 'outcome', 'code'].includes(key))) {
        throw new TypeError('PLATFORM_AUDIT_EVENT_INVALID');
      }
      const { adminId = null, sessionId = null, action, outcome, code = null } = event;
      if (adminId !== null && (!Number.isSafeInteger(adminId) || adminId < 1)) throw new TypeError('PLATFORM_AUDIT_ADMIN_INVALID');
      if (sessionId !== null && (typeof sessionId !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(sessionId))) throw new TypeError('PLATFORM_AUDIT_SESSION_INVALID');
      if (!ACTIONS.has(action) || !OUTCOMES.has(outcome)) throw new TypeError('PLATFORM_AUDIT_EVENT_INVALID');
      if (code !== null && (typeof code !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(code))) throw new TypeError('PLATFORM_AUDIT_CODE_INVALID');
      await pool.query(
        'INSERT INTO platform_admin_audit_events (admin_id, session_id, action, outcome, detail_code) VALUES (?, ?, ?, ?, ?)',
        [adminId, sessionId, action, outcome, code]
      );
      return true;
    }
  });
}

module.exports = { ACTIONS, OUTCOMES, createPlatformAdminAuditStore };
