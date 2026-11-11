'use strict';

function parseEnvelope(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* fail closed below */ }
  }
  throw Object.assign(new Error('PLATFORM_MFA_ENVELOPE_INVALID'), { code: 'PLATFORM_MFA_ENVELOPE_INVALID', status: 503 });
}

function createPlatformAdminMfaStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
    throw new TypeError('PLATFORM_MFA_DATABASE_POOL_REQUIRED');
  }
  return Object.freeze({
    async savePendingEnrollment({ adminId, encryptedSecret, expiresAt }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || !Number.isSafeInteger(expiresAt) ||
          !encryptedSecret || typeof encryptedSecret !== 'object') throw new TypeError('PLATFORM_MFA_ENROLLMENT_INVALID');
      await pool.query(
        'INSERT INTO platform_admin_mfa_enrollments (admin_id, encrypted_secret, expires_at) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE encrypted_secret = VALUES(encrypted_secret), expires_at = VALUES(expires_at)',
        [adminId, JSON.stringify(encryptedSecret), new Date(expiresAt * 1000)]
      );
    },
    async getPendingEnrollment(adminId) {
      if (!Number.isSafeInteger(adminId) || adminId < 1) return null;
      const [rows] = await pool.query(
        'SELECT encrypted_secret, UNIX_TIMESTAMP(expires_at) AS expires_at FROM platform_admin_mfa_enrollments WHERE admin_id = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
        [adminId]
      );
      if (!rows[0]) return null;
      return { encryptedSecret: parseEnvelope(rows[0].encrypted_secret), expiresAt: Number(rows[0].expires_at) };
    },
    async activateFactor({ adminId, encryptedSecret, lastTotpCounter, recoveryCodeHashes }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || !encryptedSecret ||
          !Number.isSafeInteger(lastTotpCounter) || lastTotpCounter < 0 ||
          !Array.isArray(recoveryCodeHashes) || recoveryCodeHashes.length !== 10 ||
          recoveryCodeHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
        throw new TypeError('PLATFORM_MFA_FACTOR_INVALID');
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [pendingRows] = await connection.query(
          'SELECT encrypted_secret FROM platform_admin_mfa_enrollments WHERE admin_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE',
          [adminId]
        );
        if (!pendingRows[0] ||
            JSON.stringify(parseEnvelope(pendingRows[0].encrypted_secret)) !== JSON.stringify(encryptedSecret)) {
          throw Object.assign(new Error('PLATFORM_MFA_ENROLLMENT_CONFLICT'), {
            code: 'PLATFORM_MFA_ENROLLMENT_CONFLICT', status: 409
          });
        }
        await connection.query(
          'INSERT INTO platform_admin_mfa_factors (admin_id, encrypted_secret, enabled, last_totp_counter) VALUES (?, ?, 1, ?) ' +
          'ON DUPLICATE KEY UPDATE encrypted_secret = VALUES(encrypted_secret), enabled = 1, last_totp_counter = VALUES(last_totp_counter)',
          [adminId, JSON.stringify(encryptedSecret), lastTotpCounter]
        );
        await connection.query('DELETE FROM platform_admin_mfa_recovery_codes WHERE admin_id = ?', [adminId]);
        for (const hash of recoveryCodeHashes) {
          await connection.query(
            'INSERT INTO platform_admin_mfa_recovery_codes (admin_id, code_hash) VALUES (?, ?)',
            [adminId, hash]
          );
        }
        await connection.query('DELETE FROM platform_admin_mfa_enrollments WHERE admin_id = ?', [adminId]);
        await connection.commit();
      } catch (error) {
        try { await connection.rollback(); } catch (_) { /* preserve original failure */ }
        throw error;
      } finally {
        connection.release();
      }
    },
    async getFactor(adminId) {
      if (!Number.isSafeInteger(adminId) || adminId < 1) return null;
      const [rows] = await pool.query(
        'SELECT encrypted_secret, enabled, last_totp_counter FROM platform_admin_mfa_factors WHERE admin_id = ? LIMIT 1',
        [adminId]
      );
      if (!rows[0]) return null;
      return {
        encryptedSecret: parseEnvelope(rows[0].encrypted_secret),
        enabled: Number(rows[0].enabled) === 1,
        lastTotpCounter: Number(rows[0].last_totp_counter)
      };
    },
    async consumeTotpCounter({ adminId, counter }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || !Number.isSafeInteger(counter) || counter < 0) return false;
      const [result] = await pool.query(
        'UPDATE platform_admin_mfa_factors SET last_totp_counter = ? WHERE admin_id = ? AND enabled = 1 AND last_totp_counter < ?',
        [counter, adminId, counter]
      );
      return Number(result.affectedRows) === 1;
    },
    async consumeRecoveryCode({ adminId, codeHash }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 || typeof codeHash !== 'string' || !/^[a-f0-9]{64}$/.test(codeHash)) return false;
      const [result] = await pool.query(
        'DELETE FROM platform_admin_mfa_recovery_codes WHERE admin_id = ? AND code_hash = ?',
        [adminId, codeHash]
      );
      return Number(result.affectedRows) === 1;
    },
    async replaceRecoveryCodes({ adminId, recoveryCodeHashes }) {
      if (!Number.isSafeInteger(adminId) || adminId < 1 ||
          !Array.isArray(recoveryCodeHashes) || recoveryCodeHashes.length !== 10 ||
          recoveryCodeHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
          new Set(recoveryCodeHashes).size !== recoveryCodeHashes.length) return false;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          'SELECT admin_id FROM platform_admin_mfa_factors WHERE admin_id = ? AND enabled = 1 FOR UPDATE',
          [adminId]
        );
        if (!rows[0]) {
          await connection.rollback();
          return false;
        }
        await connection.query('DELETE FROM platform_admin_mfa_recovery_codes WHERE admin_id = ?', [adminId]);
        for (const hash of recoveryCodeHashes) {
          await connection.query(
            'INSERT INTO platform_admin_mfa_recovery_codes (admin_id, code_hash) VALUES (?, ?)',
            [adminId, hash]
          );
        }
        await connection.commit();
        return true;
      } catch (error) {
        try { await connection.rollback(); } catch (_) { /* preserve original failure */ }
        throw error;
      } finally {
        connection.release();
      }
    }
  });
}

module.exports = { createPlatformAdminMfaStore, parseEnvelope };
