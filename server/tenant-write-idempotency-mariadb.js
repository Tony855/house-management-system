'use strict';

const { APP_IDS } = require('./tenant-registry');
const { UUID_RE } = require('./tenant-identity-migration');

function createMariaDbTenantWriteIdempotencyStore() {
  return Object.freeze({
    async execute(tx, input, mutate) {
      if (!tx || typeof tx.execute !== 'function') throw new TypeError('TENANT_WRITE_TRANSACTION_EXECUTE_REQUIRED');
      if (!input || !APP_IDS.has(input.appId) || !UUID_RE.test(input.tenantId || '') ||
          typeof input.userId !== 'string' || !input.userId ||
          typeof input.requestId !== 'string' || !input.requestId ||
          !/^[a-f0-9]{64}$/.test(input.requestFingerprint || '') || typeof mutate !== 'function') {
        throw new TypeError('TENANT_WRITE_IDEMPOTENCY_INPUT_INVALID');
      }
      await tx.execute(
        'INSERT IGNORE INTO tenant_write_idempotency (app_id, tenant_uuid, user_id, request_id, request_fingerprint, state) VALUES (?, ?, ?, ?, ?, \'processing\')',
        [input.appId, input.tenantId, input.userId, input.requestId, input.requestFingerprint]
      );
      const [rows] = await tx.execute(
        'SELECT request_fingerprint, state, response_json FROM tenant_write_idempotency WHERE app_id = ? AND tenant_uuid = ? AND user_id = ? AND request_id = ? FOR UPDATE',
        [input.appId, input.tenantId, input.userId, input.requestId]
      );
      const record = rows[0];
      if (!record) throw new Error('TENANT_WRITE_IDEMPOTENCY_RECORD_MISSING');
      if (record.request_fingerprint !== input.requestFingerprint) return { status: 'conflict' };
      if (record.state === 'completed') {
        let result;
        try { result = JSON.parse(record.response_json); } catch (_) { throw new Error('TENANT_WRITE_IDEMPOTENCY_RESPONSE_CORRUPT'); }
        return { status: 'replayed', result };
      }
      if (record.state !== 'processing') throw new Error('TENANT_WRITE_IDEMPOTENCY_STATE_INVALID');

      const result = await mutate();
      let response;
      try {
        response = JSON.stringify(result);
        if (response === undefined) throw new Error('UNSERIALIZABLE');
      } catch (_) {
        throw new TypeError('TENANT_WRITE_IDEMPOTENCY_RESULT_NOT_SERIALIZABLE');
      }
      const [updated] = await tx.execute(
        'UPDATE tenant_write_idempotency SET state = \'completed\', response_json = ?, completed_at = UTC_TIMESTAMP() WHERE app_id = ? AND tenant_uuid = ? AND user_id = ? AND request_id = ? AND request_fingerprint = ? AND state = \'processing\'',
        [response, input.appId, input.tenantId, input.userId, input.requestId, input.requestFingerprint]
      );
      if (Number(updated.affectedRows) !== 1) throw new Error('TENANT_WRITE_IDEMPOTENCY_COMPLETION_FAILED');
      return { status: 'executed', result };
    }
  });
}
module.exports = { createMariaDbTenantWriteIdempotencyStore };
