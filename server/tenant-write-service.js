'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;

/**
 * Transactional write boundary for product-domain mutations.
 * Authorization, step-up verification and audit writes are mandatory.
 * Audit append receives the same transaction handle as the business mutation.
 */
function createTenantWriteService({ authorize, verifyStepUp, auditWriter }) {
  if (typeof authorize !== 'function') throw new TypeError('TENANT_WRITE_AUTHORIZER_REQUIRED');
  if (typeof verifyStepUp !== 'function') throw new TypeError('TENANT_WRITE_STEP_UP_REQUIRED');
  if (!auditWriter || typeof auditWriter.append !== 'function') throw new TypeError('TENANT_WRITE_AUDIT_REQUIRED');

  return Object.freeze({
    async execute({ auth, tenantContext, repository, operation, reason, stepUpToken, requestId, mutate }) {
      if (!auth || auth.authenticated !== true || !['rental', 'hotel', 'property'].includes(auth.appId) ||
          typeof auth.userId !== 'string' || !auth.userId || typeof auth.sessionId !== 'string' || !auth.sessionId ||
          !UUID_RE.test(auth.tenantId || '') || !tenantContext ||
          tenantContext.appId !== auth.appId || tenantContext.tenantId !== auth.tenantId) {
        throw Object.assign(new Error('TENANT_WRITE_CONTEXT_INVALID'), { code: 'TENANT_WRITE_CONTEXT_INVALID', status: 403 });
      }
      if (!['create', 'update', 'delete'].includes(operation) ||
          typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500 ||
          typeof stepUpToken !== 'string' || stepUpToken.length < 16 || stepUpToken.length > 4096 ||
          !REQUEST_ID_RE.test(requestId || '') || typeof mutate !== 'function') {
        throw Object.assign(new Error('TENANT_WRITE_REQUEST_INVALID'), { code: 'TENANT_WRITE_REQUEST_INVALID', status: 400 });
      }
      if (!repository || typeof repository.withTransaction !== 'function') {
        throw new TypeError('TENANT_WRITE_REPOSITORY_REQUIRED');
      }

      const authorization = await authorize({
        auth, tenantContext, operation, requestId
      });
      if (authorization !== true) {
        throw Object.assign(new Error('TENANT_WRITE_FORBIDDEN'), { code: 'TENANT_WRITE_FORBIDDEN', status: 403 });
      }
      const verified = await verifyStepUp({
        auth, tenantContext, operation, reason: reason.trim(), token: stepUpToken
      });
      if (verified !== true) {
        throw Object.assign(new Error('TENANT_WRITE_STEP_UP_INVALID'), { code: 'TENANT_WRITE_STEP_UP_INVALID', status: 403 });
      }

      return repository.withTransaction(async tx => {
        const event = {
          appId: auth.appId, tenantId: auth.tenantId, userId: auth.userId,
          sessionId: auth.sessionId, operation, reason: reason.trim(), requestId
        };
        await auditWriter.append(tx, { ...event, event: 'tenant_write_started' });
        const result = await mutate(tx);
        await auditWriter.append(tx, { ...event, event: 'tenant_write_committed' });
        return result;
      });
    }
  });
}

module.exports = { createTenantWriteService };
