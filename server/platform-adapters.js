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
    },
    async findTenantByLoginHost(hostname, appId) {
      if (typeof hostname !== 'string' || !hostname || hostname.length > 253 || !APP_IDS.has(appId)) return null;
      const [rows] = await pool.query(
        'SELECT t.tenant_uuid, t.app_id, t.lifecycle_state FROM platform_tenant_login_hosts h JOIN platform_tenants t ON t.tenant_uuid = h.tenant_uuid WHERE h.hostname = ? AND h.app_id = ? AND h.status = \'active\' LIMIT 1',
        [hostname, appId]
      );
      return rows[0] || null;
    }
  };
}

function createPlatformProductSessionStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  return {
    async createSession({ sessionId, userId, tenantId, appId, issuedAt, expiresAt }) {
      if (typeof sessionId !== 'string' || !sessionId || typeof userId !== 'string' || !userId ||
          typeof tenantId !== 'string' || !tenantId || !APP_IDS.has(appId) ||
          !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
        throw new TypeError('PRODUCT_SESSION_INPUT_INVALID');
      }
      await pool.query(
        'INSERT INTO platform_product_sessions (session_id, app_id, tenant_uuid, subject_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [sessionId, appId, tenantId, userId, new Date(issuedAt * 1000), new Date(expiresAt * 1000)]
      );
    },
    async isSessionActive({ sessionId, userId, tenantId, appId }) {
      if (typeof sessionId !== 'string' || !sessionId ||
          typeof userId !== 'string' || !userId ||
          typeof tenantId !== 'string' || !tenantId ||
          !APP_IDS.has(appId)) return false;
      const [rows] = await pool.query(
        'SELECT 1 AS active FROM platform_product_sessions WHERE session_id = ? AND subject_id = ? AND tenant_uuid = ? AND app_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() LIMIT 1',
        [sessionId, userId, tenantId, appId]
      );
      return rows.length === 1;
    },
    async revokeSession({ sessionId, userId, tenantId, appId }) {
      if (typeof sessionId !== 'string' || !sessionId || typeof userId !== 'string' || !userId ||
          typeof tenantId !== 'string' || !tenantId || !APP_IDS.has(appId)) return false;
      const [result] = await pool.query(
        'UPDATE platform_product_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND subject_id = ? AND tenant_uuid = ? AND app_id = ? AND revoked_at IS NULL',
        [sessionId, userId, tenantId, appId]
      );
      return Number(result.affectedRows) === 1;
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

function createPlatformLoginRateLimiter(pool, {
  hmacKey, maxAttempts = 10, windowSeconds = 900, blockSeconds = 900
} = {}) {
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('PLATFORM_DB_CONNECTION_POOL_REQUIRED');
  if (!(typeof hmacKey === 'string' || Buffer.isBuffer(hmacKey)) || Buffer.byteLength(hmacKey) < 32) {
    throw new TypeError('LOGIN_RATE_LIMIT_HMAC_KEY_REQUIRED');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 3 || maxAttempts > 100 ||
      !Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400 ||
      !Number.isInteger(blockSeconds) || blockSeconds < 60 || blockSeconds > 86400) {
    throw new TypeError('LOGIN_RATE_LIMIT_OPTIONS_INVALID');
  }

  function identityHash({ appId, host, username }) {
    if (!APP_IDS.has(appId) || typeof host !== 'string' || !host || host.length > 253 ||
        typeof username !== 'string' || !username || username.length > 50) {
      throw new TypeError('LOGIN_RATE_LIMIT_IDENTITY_INVALID');
    }
    return require('node:crypto').createHmac('sha256', hmacKey)
      .update([appId, host.toLowerCase(), username.toLowerCase()].join(String.fromCharCode(0))).digest('hex');
  }

  async function withTransaction(fn) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch (_) {}
      throw error;
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    async assertAllowed(identity) {
      const hash = identityHash(identity);
      const [rows] = await pool.query(
        'SELECT (blocked_until IS NOT NULL AND blocked_until > UTC_TIMESTAMP()) AS blocked FROM platform_login_attempts WHERE app_id = ? AND identity_hash = ? LIMIT 1',
        [identity.appId, hash]
      );
      if (Number(rows[0]?.blocked) === 1) {
        throw Object.assign(new Error('LOGIN_RATE_LIMITED'), { code: 'LOGIN_RATE_LIMITED', status: 429 });
      }
      return true;
    },
    async recordFailure(identity) {
      const hash = identityHash(identity);
      await withTransaction(async connection => {
        await connection.query(
          'INSERT IGNORE INTO platform_login_attempts (app_id, identity_hash, window_started_at, failures, blocked_until) VALUES (?, ?, UTC_TIMESTAMP(), 0, NULL)',
          [identity.appId, hash]
        );
        const [rows] = await connection.query(
          'SELECT window_started_at, failures FROM platform_login_attempts WHERE app_id = ? AND identity_hash = ? FOR UPDATE',
          [identity.appId, hash]
        );
        const row = rows[0];
        const expired = !row || (Date.now() - new Date(row.window_started_at).getTime()) >= windowSeconds * 1000;
        const failures = expired ? 1 : Number(row.failures) + 1;
        const blocked = failures >= maxAttempts;
        await connection.query(
          'UPDATE platform_login_attempts SET window_started_at = IF(?, UTC_TIMESTAMP(), window_started_at), failures = ?, blocked_until = IF(?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), NULL), updated_at = UTC_TIMESTAMP() WHERE app_id = ? AND identity_hash = ?',
          [expired, failures, blocked, blockSeconds, identity.appId, hash]
        );
      });
      return true;
    },
    async clear(identity) {
      const hash = identityHash(identity);
      await pool.query('DELETE FROM platform_login_attempts WHERE app_id = ? AND identity_hash = ?', [identity.appId, hash]);
      return true;
    }
  });
}
module.exports = {
  createPlatformLoginRateLimiter,
  createPlatformTenantRegistry,
  createPlatformProductSessionStore,
  createTenantDatabaseSecretProvider
};
