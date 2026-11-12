'use strict';

const express = require('express');
const { assertPlatformAdmin } = require('./platform-authz');

function fail(code, status) { return Object.assign(new Error(code), { code, status }); }
function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) throw fail('TENANT_MIGRATION_JOB_ID_INVALID', 400);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw fail('TENANT_MIGRATION_JOB_ID_INVALID', 400);
  return id;
}
function createPlatformTenantMigrationRouter({ store, authenticate }) {
  if (!store || !['createJob', 'getJob', 'retryFailedJob', 'cancelQueuedJob'].every(name => typeof store[name] === 'function')) {
    throw new TypeError('TENANT_MIGRATION_JOB_STORE_REQUIRED');
  }
  if (typeof authenticate !== 'function') throw new TypeError('PLATFORM_AUTHENTICATOR_REQUIRED');
  const router = express.Router();

  router.post('/tenant-migrations', authenticate, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      assertPlatformAdmin(req.platformAuth, 'tenants:write', { reason: req.get('x-operation-reason') || body.reason });
      const idempotencyKey = req.get('idempotency-key');
      const job = await store.createJob({
        idempotencyKey, tenantId: body.tenantId, appId: body.appId,
        sourceOrgId: body.sourceOrgId, mode: body.mode || 'dry-run'
      });
      res.set('Cache-Control', 'no-store');
      return res.status(202).json({ job });
    } catch (error) { return next(error); }
  });

  router.get('/tenant-migrations/:id', authenticate, async (req, res, next) => {
    try {
      assertPlatformAdmin(req.platformAuth, 'tenants:read');
      const job = await store.getJob(parseId(req.params.id));
      if (!job) throw fail('TENANT_MIGRATION_JOB_NOT_FOUND', 404);
      res.set('Cache-Control', 'no-store');
      return res.json({ job });
    } catch (error) { return next(error); }
  });

  router.post('/tenant-migrations/:id/retry', authenticate, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      assertPlatformAdmin(req.platformAuth, 'tenants:write', { reason: req.get('x-operation-reason') || body.reason });
      const retried = await store.retryFailedJob({
        id: parseId(req.params.id), expectedAttemptCount: body.expectedAttemptCount
      });
      if (!retried) throw fail('TENANT_MIGRATION_JOB_RETRY_CONFLICT', 409);
      return res.status(202).json({ status: 'queued' });
    } catch (error) { return next(error); }
  });

  router.post('/tenant-migrations/:id/cancel', authenticate, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      assertPlatformAdmin(req.platformAuth, 'tenants:write', { reason: req.get('x-operation-reason') || body.reason });
      const cancelled = await store.cancelQueuedJob({ id: parseId(req.params.id) });
      if (!cancelled) throw fail('TENANT_MIGRATION_JOB_CANCEL_CONFLICT', 409);
      return res.status(200).json({ status: 'cancelled' });
    } catch (error) { return next(error); }
  });

  return router;
}
module.exports = { createPlatformTenantMigrationRouter };
