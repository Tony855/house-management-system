'use strict';

const WRITE_PERMISSIONS = new Set(['billing:write', 'billing:refund', 'billing:adjust', 'plans:write', 'tenants:write']);
const STEP_UP_PERMISSIONS = new Set(['billing:refund', 'billing:adjust', 'plans:write', 'tenants:write']);

function assertPlatformAdmin(auth, permission) {
  if (!auth || auth.authenticated !== true) throw Object.assign(new Error('PLATFORM_AUTH_REQUIRED'), { status: 401, code: 'PLATFORM_AUTH_REQUIRED' });
  if (auth.audience !== 'platform' || auth.appId !== 'platform') throw Object.assign(new Error('PLATFORM_AUDIENCE_MISMATCH'), { status: 403, code: 'PLATFORM_AUDIENCE_MISMATCH' });
  if (auth.adminStatus !== 'active') throw Object.assign(new Error('PLATFORM_ADMIN_INACTIVE'), { status: 403, code: 'PLATFORM_ADMIN_INACTIVE' });
  if (auth.mfaVerified !== true) throw Object.assign(new Error('PLATFORM_MFA_REQUIRED'), { status: 403, code: 'PLATFORM_MFA_REQUIRED' });
  if (typeof permission !== 'string' || !permission || !Array.isArray(auth.permissions) || !auth.permissions.includes(permission)) {
    throw Object.assign(new Error('PLATFORM_PERMISSION_DENIED'), { status: 403, code: 'PLATFORM_PERMISSION_DENIED' });
  }
  if (WRITE_PERMISSIONS.has(permission) && auth.stepUpVerified !== true) {
    throw Object.assign(new Error('PLATFORM_STEP_UP_REQUIRED'), { status: 403, code: 'PLATFORM_STEP_UP_REQUIRED' });
  }
  if (STEP_UP_PERMISSIONS.has(permission) && (typeof auth.reason !== 'string' || auth.reason.trim().length < 8)) {
    throw Object.assign(new Error('PLATFORM_ACTION_REASON_REQUIRED'), { status: 400, code: 'PLATFORM_ACTION_REASON_REQUIRED' });
  }
  return true;
}

module.exports = { assertPlatformAdmin };
