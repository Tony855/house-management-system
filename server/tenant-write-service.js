'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function writeError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

/**
 * Transactional write boundary for product-domain mutations.
 * Authorization, step-up, idempotency and audit adapters are mandatory.
 * The idempotency adapter must atomically claim/replay a key in the same
 * transaction and reject a key reused with a different request fingerprint.
 */
function createTenantWriteService({ authorize, verifyStepUp, auditWriter, idempotencyStore }) {
  if (typeof authorize !== 'function') throw new TypeError('TENANT_WRITE_AUTHORIZER_REQUIRED');
  if (typeof verifyStepUp !== 'function') throw new TypeError('TENANT_WRITE_STEP_UP_REQUIRED');
  if (!auditWriter || typeof auditWriter.append !== 'function') throw new TypeError('TENANT_WRITE_AUDIT_REQUIRED');
  if (!idempotencyStore || typeof idempotencyStore.execute !== 'function') {
    throw new TypeError('TENANT_WRITE_IDEMPOTENCY_REQUIRED');
  }

  return Object.freeze({
    async execute({ auth, tenantContext, repository, operation, reason, stepUpToken, requestId, requestFingerprint, mutate }) {
      if (!auth || auth.authenticated !== true || !['rental', 'hotel', 'property'].includes(auth.appId) ||
          typeof auth.userId !== 'string' || !auth.userId || typeof auth.sessionId !== 'string' || !auth.sessionId ||
          !UUID_RE.test(auth.tenantId || '') || !tenantContext ||
          tenantContext.appId !== auth.appId || tenantContext.tenantId !== auth.tenantId) {
        throw writeError('TENANT_WRITE_CONTEXT_INVALID', 403);
      }
      if (!['create', 'update', 'delete'].includes(operation) ||
          typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500 ||
          typeof stepUpToken !== 'string' || stepUpToken.length < 16 || stepUpToken.length > 4096 ||
          !REQUEST_ID_RE.test(requestId || '') || !FINGERPRINT_RE.test(requestFingerprint || '') ||
          typeof mutate !== 'function') {
        throw writeError('TENANT_WRITE_REQUEST_INVALID', 400);
      }
      if (!repository || typeof repository.withTransaction !== 'function') {
        throw new TypeError('TENANT_WRITE_REPOSITORY_REQUIRED');
      }

      const authorization = await authorize({ auth, tenantContext, operation, requestId });
      if (authorization !== true) throw writeError('TENANT_WRITE_FORBIDDEN', 403);
      const verified = await verifyStepUp({
        auth, tenantContext, operation, reason: reason.trim(), token: stepUpToken
      });
      if (verified !== true) throw writeError('TENANT_WRITE_STEP_UP_INVALID', 403);

      return repository.withTransaction(async tx => {
        const event = {
          appId: auth.appId, tenantId: auth.tenantId, userId: auth.userId,
          sessionId: auth.sessionId, operation, reason: reason.trim(), requestId
        };
        await auditWriter.append(tx, { ...event, event: 'tenant_write_started' });
        const execution = await idempotencyStore.execute(tx, {
          ...event, requestFingerprint
        }, () => mutate(tx));
        if (!execution || !['executed', 'replayed', 'conflict'].includes(execution.status)) {
          throw new TypeError('TENANT_WRITE_IDEMPOTENCY_RESULT_INVALID');
        }
        if (execution.status === 'conflict') throw writeError('TENANT_WRITE_IDEMPOTENCY_CONFLICT', 409);
        if (execution.status === 'replayed') {
          await auditWriter.append(tx, { ...event, event: 'tenant_write_replayed' });
          return execution.result;
        }
        await auditWriter.append(tx, { ...event, event: 'tenant_write_committed' });
        return execution.result;
      });
    }
  });
}

module.exports = { createTenantWriteService };
