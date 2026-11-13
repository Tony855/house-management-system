'use strict';

const express = require('express');
const { createPlatformBillingRouter } = require('./routes');
const { createPlatformRepository } = require('./repository');
const { createPlatformAuthRouter } = require('./auth-routes');
const { createPlatformTenantMigrationJobStore } = require('../../server/tenant-migration-job-store');
const { createPlatformTenantMigrationRouter } = require('./tenant-migration-routes');
const { createPlatformTenantMigrationWorker } = require('../../server/tenant-migration-worker');
const { createPlatformTenantMigrationRunner } = require('../../server/tenant-migration-runner');

function createPlatformApi({ pool, authenticate, adminAuthService, mfaService, auditStore, adminStore, migrationExecutor, migrationWorkerId = process.env.MIGRATION_WORKER_ID || 'platform-api-worker', migrationConcurrency = 2 }) {
  if (!pool) throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  const resolvedAuthenticate = authenticate || (adminAuthService && adminAuthService.authenticate);
  if (typeof resolvedAuthenticate !== 'function') throw new TypeError('PLATFORM_AUTHENTICATOR_REQUIRED');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/health/live', (_req, res) => res.json({ ok: true, service: 'platform-api' }));
  if (adminAuthService) app.use('/api/platform/auth', createPlatformAuthRouter({ authService: adminAuthService, mfaService, auditStore, adminStore }));
  app.use('/api/platform', createPlatformBillingRouter({
    repository: createPlatformRepository(pool),
    authenticate: resolvedAuthenticate
  }));
  const migrationStore = createPlatformTenantMigrationJobStore(pool);
  app.use('/api/platform', createPlatformTenantMigrationRouter({
    store: migrationStore,
    authenticate: resolvedAuthenticate
  }));
  if (migrationExecutor !== undefined) {
    const worker = createPlatformTenantMigrationWorker({
      store: migrationStore, workerId: migrationWorkerId, executeJob: migrationExecutor
    });
    const runner = createPlatformTenantMigrationRunner({
      store: migrationStore, worker, concurrency: migrationConcurrency
    });
    runner.start();
    app.locals.stopTenantMigrationRunner = () => runner.stop();
    app.locals.tenantMigrationRunner = runner;
  } else {
    app.locals.stopTenantMigrationRunner = async () => {};
  }
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    res.status(status).json({ error: status >= 500 ? 'INTERNAL_ERROR' : (err.code || 'REQUEST_FAILED') });
  });
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}

module.exports = { createPlatformApi };
