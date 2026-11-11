'use strict';

const express = require('express');
const { createPlatformBillingRouter } = require('./routes');
const { createPlatformRepository } = require('./repository');
const { createPlatformAuthRouter } = require('./auth-routes');

function createPlatformApi({ pool, authenticate, adminAuthService }) {
  if (!pool) throw new TypeError('PLATFORM_DB_POOL_REQUIRED');
  const resolvedAuthenticate = authenticate || (adminAuthService && adminAuthService.authenticate);
  if (typeof resolvedAuthenticate !== 'function') throw new TypeError('PLATFORM_AUTHENTICATOR_REQUIRED');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/health/live', (_req, res) => res.json({ ok: true, service: 'platform-api' }));
  if (adminAuthService) app.use('/api/platform/auth', createPlatformAuthRouter({ authService: adminAuthService }));
  app.use('/api/platform', createPlatformBillingRouter({
    repository: createPlatformRepository(pool),
    authenticate: resolvedAuthenticate
  }));
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    res.status(status).json({ error: status >= 500 ? 'INTERNAL_ERROR' : (err.code || 'REQUEST_FAILED') });
  });
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}

module.exports = { createPlatformApi };
