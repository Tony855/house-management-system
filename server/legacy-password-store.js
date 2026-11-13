'use strict';

function createLegacyPasswordStore(pool) {
  if (!pool || typeof pool.getConnection !== 'function') {
    throw new TypeError('LEGACY_PASSWORD_TRANSACTION_POOL_REQUIRED');
  }
  return Object.freeze({
    async updatePasswordAndRevokeSessions({ userId, passwordHash, realName } = {}) {
      const id = Number(userId);
      if (!Number.isSafeInteger(id) || id < 1 ||
          typeof passwordHash !== 'string' || !/^[a-f0-9]{16}:[a-f0-9]{64}$/i.test(passwordHash) ||
          (realName !== undefined && (typeof realName !== 'string' || realName.length > 120))) {
        throw new TypeError('LEGACY_PASSWORD_UPDATE_INVALID');
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (realName === undefined) {
          await connection.query('UPDATE users SET password = ? WHERE id = ?', [passwordHash, id]);
        } else {
          await connection.query('UPDATE users SET password = ?, real_name = ? WHERE id = ?', [passwordHash, realName, id]);
        }
        await connection.query('DELETE FROM sessions WHERE user_id = ?', [id]);
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

module.exports = { createLegacyPasswordStore };
