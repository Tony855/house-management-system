'use strict';

const { fingerprintPayload } = require('./tenant-write-service');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const JOBS = Object.freeze({ rental: 'rental_bill', property: 'property_fee' });

function systemWriteError(code, status = 403) {
  return Object.assign(new Error(code), { code, status });
}

/**
 * Separate machine-actor write boundary. It deliberately has no user/session
 * impersonation and no user step-up token. A deployment must provide an
 * explicit policy authorizer for the exact app, tenant and job type.
 */
function createTenantSystemWriteService({ authorizeSystem, auditWriter, idempotencyStore }) {
  if (typeof authorizeSystem !== 'function') throw new TypeError('TENANT_SYSTEM_WRITE_AUTHORIZER_REQUIRED');
  if (!auditWriter || typeof auditWriter.appendSystem !== 'function') throw new TypeError('TENANT_SYSTEM_WRITE_AUDIT_REQUIRED');
  if (!idempotencyStore || typeof idempotencyStore.execute !== 'function') throw new TypeError('TENANT_SYSTEM_WRITE_IDEMPOTENCY_REQUIRED');

  return Object.freeze({
    async execute({ workerId, appId, tenantId, tenantContext, repository, jobType, requestId, payload, mutate }) {
      if (!WORKER_RE.test(workerId || '') || !Object.hasOwn(JOBS, appId) || JOBS[appId] !== jobType ||
          !UUID_RE.test(tenantId || '') || !tenantContext || tenantContext.appId !== appId ||
          tenantContext.tenantId !== tenantId) throw systemWriteError('TENANT_SYSTEM_WRITE_CONTEXT_INVALID');
      if (!REQUEST_ID_RE.test(requestId || '') || typeof mutate !== 'function') {
        throw systemWriteError('TENANT_SYSTEM_WRITE_REQUEST_INVALID', 400);
      }
      if (!repository || typeof repository.withTransaction !== 'function') {
        throw new TypeError('TENANT_SYSTEM_WRITE_REPOSITORY_REQUIRED');
      }
      const authorization = await authorizeSystem({ workerId, appId, tenantId, jobType });
      if (authorization !== true) throw systemWriteError('TENANT_SYSTEM_WRITE_FORBIDDEN');
      const requestFingerprint = fingerprintPayload(payload);
      const event = {
        workerId, appId, tenantId, jobType, operation: 'update',
        reason: 'Automated ' + jobType + ' generation',
        requestId
      };
      return repository.withTransaction(async tx => {
        await auditWriter.appendSystem(tx, { ...event, event: 'tenant_system_write_started' });
        const execution = await idempotencyStore.execute(tx, {
          appId, tenantId, userId: 'system:' + workerId, requestId, requestFingerprint
        }, () => mutate(tx, payload));
        if (!execution || !['executed', 'replayed', 'conflict'].includes(execution.status)) {
          throw new TypeError('TENANT_SYSTEM_WRITE_IDEMPOTENCY_RESULT_INVALID');
        }
        if (execution.status === 'conflict') throw systemWriteError('TENANT_SYSTEM_WRITE_IDEMPOTENCY_CONFLICT', 409);
        await auditWriter.appendSystem(tx, {
          ...event,
          event: execution.status === 'replayed'
            ? 'tenant_system_write_replayed' : 'tenant_system_write_committed'
        });
        return execution.result;
      });
    }
  });
}

module.exports = { createTenantSystemWriteService };
