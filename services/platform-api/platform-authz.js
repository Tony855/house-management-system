'use strict';

const WRITE_PERMISSIONS = new Set(['billing:write', 'billing:refund', 'billing:adjust', 'plans:write', 'tenants:write']);
const REASON_REQUIRED_PERMISSIONS = new Set(['billing:refund', 'billing:adjust', 'plans:write', 'tenants:write']);
function fail(code, status) { throw Object.assign(new Error(code), { status, code }); }

function assertPlatformAdmin(auth, permission, options = {}) {
  if (!auth || auth.authenticated !== true) fail('PLATFORM_AUTH_REQUIRED', 401);
  if (auth.audience !== 'platform' || auth.appId !== 'platform') fail('PLATFORM_AUDIENCE_MISMATCH', 403);
  if (auth.adminStatus !== 'active') fail('PLATFORM_ADMIN_INACTIVE', 403);
  if (!Number.isSafeInteger(auth.adminId) || auth.adminId < 1) fail('PLATFORM_ADMIN_ID_REQUIRED', 403);
  if (auth.mfaVerified !== true) fail('PLATFORM_MFA_REQUIRED', 403);
  if (typeof permission !== 'string' || !permission || !Array.isArray(auth.permissions) || !auth.permissions.includes(permission)) {
    fail('PLATFORM_PERMISSION_DENIED', 403);
  }
  if (WRITE_PERMISSIONS.has(permission) && auth.stepUpVerified !== true) fail('PLATFORM_STEP_UP_REQUIRED', 403);
  if (REASON_REQUIRED_PERMISSIONS.has(permission) &&
      (!options || typeof options.reason !== 'string' || options.reason.trim().length < 8)) {
    fail('PLATFORM_ACTION_REASON_REQUIRED', 400);
  }
  return true;
}
module.exports = { assertPlatformAdmin };
