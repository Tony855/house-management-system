'use strict';

const APP_IDS = new Set(['rental', 'hotel', 'property']);

function createPlatformTenantRegistry(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  return {
    async findTenantById(tenantId) {
      const [rows] = await pool.query(
        'SELECT tenant_uuid, app_id, lifecycle_state, db_host, db_port, db_name, db_secret_ref, schema_version FROM platform_tenants WHERE tenant_uuid = ? LIMIT 1',
        [tenantId]
      );
      return rows[0] || null;
    }
  };
}

function createPlatformProductSessionStore(pool, { now = () => new Date() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  if (typeof now !== 'function') throw new TypeError('SESSION_STORE_CLOCK_INVALID');
  return {
    async isSessionActive({ sessionId, userId, tenantId, appId }) {
      if (typeof sessionId !== 'string' || !sessionId ||
          typeof userId !== 'string' || !userId ||
          typeof tenantId !== 'string' || !tenantId ||
          !APP_IDS.has(appId)) return false;
      const current = now();
      if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new TypeError('SESSION_STORE_CLOCK_INVALID');
      const [rows] = await pool.query(
        'SELECT 1 AS active FROM platform_product_sessions WHERE session_id = ? AND subject_id = ? AND tenant_uuid = ? AND app_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
        [sessionId, userId, tenantId, appId, current]
      );
      return rows.length === 1;
    }
  };
}

function createTenantDatabaseSecretProvider(secretManager) {
  if (!secretManager || typeof secretManager.getSecret !== 'function') {
    throw new TypeError('TENANT_SECRET_MANAGER_REQUIRED');
  }
  return {
    async getDatabaseCredentials(secretRef) {
      if (typeof secretRef !== 'string' || !secretRef || secretRef.length > 255) {
        throw new TypeError('TENANT_SECRET_REFERENCE_INVALID');
      }
      const secret = await secretManager.getSecret(secretRef);
      if (!secret || typeof secret.user !== 'string' || !secret.user ||
          typeof secret.password !== 'string' || !secret.password) {
        throw Object.assign(new Error('TENANT_DATABASE_CREDENTIALS_UNAVAILABLE'), {
          code: 'TENANT_DATABASE_CREDENTIALS_UNAVAILABLE', status: 503
        });
      }
      return Object.freeze({
        user: secret.user,
        password: secret.password,
        version: typeof secret.version === 'string' ? secret.version : ''
      });
    }
  };
}

module.exports = {
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createTenantDatabaseSecretProvider
};
