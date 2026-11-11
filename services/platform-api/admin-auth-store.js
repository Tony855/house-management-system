'use strict';

function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : fallback; }
  catch (_) { return fallback; }
}

function createPlatformAdminAuthStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PLATFORM_ADMIN_AUTH_POOL_REQUIRED');
  return Object.freeze({
    async findByUsername(username) {
      const [rows] = await pool.query(
        'SELECT id, password_hash, status, mfa_required, permissions_json FROM platform_admins WHERE username = ? LIMIT 1',
        [username]
      );
      if (!rows[0]) return null;
      return {
        id: Number(rows[0].id), passwordHash: rows[0].password_hash,
        status: rows[0].status, mfaRequired: Number(rows[0].mfa_required) === 1,
        permissions: parseJson(rows[0].permissions_json)
      };
    },
    async findById(adminId) {
      if (!Number.isSafeInteger(adminId) || adminId < 1) return null;
      const [rows] = await pool.query(
        'SELECT id, status, mfa_required, permissions_json FROM platform_admins WHERE id = ? LIMIT 1',
        [adminId]
      );
      if (!rows[0]) return null;
      return {
        id: Number(rows[0].id), status: rows[0].status,
        mfaRequired: Number(rows[0].mfa_required) === 1,
        permissions: parseJson(rows[0].permissions_json)
      };
    },
    async createChallenge({ challengeHash, adminId, expiresAt }) {
      if (!/^[a-f0-9]{64}$/.test(challengeHash) || !Number.isSafeInteger(adminId) ||
          adminId < 1 || !Number.isSafeInteger(expiresAt)) throw new TypeError('PLATFORM_MFA_CHALLENGE_INVALID');
      await pool.query(
        'INSERT INTO platform_admin_login_challenges (challenge_hash, admin_id, expires_at) VALUES (?, ?, ?)',
        [challengeHash, adminId, new Date(expiresAt * 1000)]
      );
    },
    async getChallenge(challengeHash) {
      if (typeof challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(challengeHash)) return null;
      const [rows] = await pool.query(
        'SELECT admin_id, UNIX_TIMESTAMP(expires_at) AS expires_at, consumed_at, attempts FROM platform_admin_login_challenges WHERE challenge_hash = ? AND expires_at > UTC_TIMESTAMP() AND consumed_at IS NULL AND attempts < 5 LIMIT 1',
        [challengeHash]
      );
      if (!rows[0]) return null;
      return {
        adminId: Number(rows[0].admin_id), expiresAt: Number(rows[0].expires_at),
        consumedAt: rows[0].consumed_at, attempts: Number(rows[0].attempts)
      };
    },
    async recordChallengeFailure({ challengeHash, adminId }) {
      if (typeof challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(challengeHash) ||
          !Number.isSafeInteger(adminId) || adminId < 1) return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_login_challenges SET attempts = attempts + 1 WHERE challenge_hash = ? AND admin_id = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() AND attempts < 5',
        [challengeHash, adminId]
      );
      return Number(result.affectedRows) === 1;
    },
    async consumeChallenge({ challengeHash, adminId }) {
      if (typeof challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(challengeHash) ||
          !Number.isSafeInteger(adminId) || adminId < 1) return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_login_challenges SET consumed_at = UTC_TIMESTAMP() WHERE challenge_hash = ? AND admin_id = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() AND attempts < 5',
        [challengeHash, adminId]
      );
      return Number(result.affectedRows) === 1;
    },
    async createSession({ sessionId, adminId, issuedAt, expiresAt, mfaVerifiedAt, permissions }) {
      if (typeof sessionId !== 'string' || sessionId.length < 40 || !Number.isSafeInteger(adminId) ||
          adminId < 1 || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
          expiresAt <= issuedAt || !Number.isSafeInteger(mfaVerifiedAt) || !Array.isArray(permissions)) {
        throw new TypeError('PLATFORM_ADMIN_SESSION_INVALID');
      }
      await pool.query(
        'INSERT INTO platform_admin_sessions (session_id, admin_id, issued_at, expires_at, last_mfa_verified_at, permissions_json) VALUES (?, ?, ?, ?, ?, ?)',
        [sessionId, adminId, new Date(issuedAt * 1000), new Date(expiresAt * 1000), new Date(mfaVerifiedAt * 1000), JSON.stringify(permissions)]
      );
    },
    async getActiveSession({ sessionId, adminId, now }) {
      if (typeof sessionId !== 'string' || !Number.isSafeInteger(adminId) || !Number.isSafeInteger(now)) return null;
      const [rows] = await pool.query(
        'SELECT a.permissions_json, UNIX_TIMESTAMP(s.last_mfa_verified_at) AS mfa_verified_at, UNIX_TIMESTAMP(s.last_step_up_at) AS step_up_verified_at, a.status AS admin_status FROM platform_admin_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.session_id = ? AND s.admin_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND a.status = \'active\' LIMIT 1',
        [sessionId, adminId]
      );
      if (!rows[0]) return null;
      return {
        status: 'active', adminStatus: rows[0].admin_status,
        mfaVerifiedAt: Number(rows[0].mfa_verified_at),
        stepUpVerifiedAt: rows[0].step_up_verified_at === null ? null : Number(rows[0].step_up_verified_at),
        permissions: parseJson(rows[0].permissions_json)
      };
    },
    async touchMfaVerified({ adminId, sessionId, verifiedAt }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || typeof sessionId !== 'string' ||
          !Number.isSafeInteger(verifiedAt)) return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_sessions SET last_mfa_verified_at = ? WHERE session_id = ? AND admin_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
        [new Date(verifiedAt * 1000), sessionId, adminId]
      );
      return Number(result.affectedRows) === 1;
    },
    async touchStepUpVerified({ adminId, sessionId, verifiedAt }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || typeof sessionId !== 'string' ||
          !Number.isSafeInteger(verifiedAt)) return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_sessions SET last_step_up_at = ? WHERE session_id = ? AND admin_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
        [new Date(verifiedAt * 1000), sessionId, adminId]
      );
      return Number(result.affectedRows) === 1;
    },
    async revokeSession({ adminId, sessionId }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || typeof sessionId !== 'string') return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND admin_id = ? AND revoked_at IS NULL',
        [sessionId, adminId]
      );
      return Number(result.affectedRows) === 1;
    }
    ,
    async disableAdmin({ actorAdminId, targetAdminId, sessionId }) {
      if (!Number.isSafeInteger(actorAdminId) || actorAdminId < 1 ||
          !Number.isSafeInteger(targetAdminId) || targetAdminId < 1 || actorAdminId === targetAdminId ||
          typeof sessionId !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(sessionId)) return false;
      if (typeof pool.getConnection !== 'function') throw new TypeError('PLATFORM_ADMIN_TRANSACTION_REQUIRED');
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [activeRows] = await connection.query(
          "SELECT id FROM platform_admins WHERE status = 'active' FOR UPDATE"
        );
        if (!activeRows.some(row => Number(row.id) === actorAdminId) ||
            !activeRows.some(row => Number(row.id) === targetAdminId) || activeRows.length <= 1) {
          await connection.rollback();
          return false;
        }
        const [updated] = await connection.query(
          "UPDATE platform_admins SET status = 'disabled' WHERE id = ? AND status = 'active'",
          [targetAdminId]
        );
        if (Number(updated.affectedRows) !== 1) {
          await connection.rollback();
          return false;
        }
        await connection.query(
          'UPDATE platform_admin_sessions SET revoked_at = UTC_TIMESTAMP() WHERE admin_id = ? AND revoked_at IS NULL',
          [targetAdminId]
        );
        await connection.query(
          'INSERT INTO platform_admin_audit_events (admin_id, session_id, action, outcome, detail_code) VALUES (?, ?, ?, ?, ?)',
          [actorAdminId, sessionId, 'admin.disable', 'success', 'TARGET_ADMIN_' + targetAdminId]
        );
        await connection.commit();
        return true;
      } catch (error) {
        try { await connection.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      } finally {
        connection.release();
      }
    },
    async resetAdminMfa({ actorAdminId, targetAdminId, sessionId, reason }) {
      if (!Number.isSafeInteger(actorAdminId) || actorAdminId < 1 ||
          !Number.isSafeInteger(targetAdminId) || targetAdminId < 1 || actorAdminId === targetAdminId ||
          typeof sessionId !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(sessionId) ||
          typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) return false;
      if (typeof pool.getConnection !== 'function') throw new TypeError('PLATFORM_ADMIN_TRANSACTION_REQUIRED');
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          "SELECT id FROM platform_admins WHERE id = ? AND status = 'active' FOR UPDATE",
          [targetAdminId]
        );
        if (!rows[0]) {
          await connection.rollback();
          return false;
        }
        await connection.query(
          'UPDATE platform_admin_mfa_factors SET enabled = 0 WHERE admin_id = ?',
          [targetAdminId]
        );
        await connection.query('DELETE FROM platform_admin_mfa_recovery_codes WHERE admin_id = ?', [targetAdminId]);
        await connection.query('DELETE FROM platform_admin_mfa_enrollments WHERE admin_id = ?', [targetAdminId]);
        await connection.query(
          'UPDATE platform_admin_sessions SET revoked_at = UTC_TIMESTAMP() WHERE admin_id = ? AND revoked_at IS NULL',
          [targetAdminId]
        );
        await connection.query(
          'INSERT INTO platform_admin_audit_events (admin_id, session_id, action, outcome, detail_code) VALUES (?, ?, ?, ?, ?)',
          [actorAdminId, sessionId, 'admin.mfa.reset', 'success', 'TARGET_ADMIN_' + targetAdminId]
        );
        await connection.commit();
        return true;
      } catch (error) {
        try { await connection.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      } finally {
        connection.release();
      }
    }
  });
}

module.exports = { createPlatformAdminAuthStore, parseJson };
