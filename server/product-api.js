'use strict';

const express = require('express');
const { createTenantMiddleware } = require('./tenant-middleware');
const { createTenantRepository } = require('./tenant-repository');

const PRODUCT_IDS = new Set(['rental', 'hotel', 'property']);

function asyncBoundary(fn) {
  return (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
}

/**
 * Creates an isolated product API process boundary.
 *
 * Authentication is deliberately injected: the service must receive a verifier
 * that validates signature, issuer, expiry, audience and appId before setting
 * req.auth. No tenant identifier from request input is trusted.
 */
function createProductApi({ appId, authenticate, registry, secretProvider, poolManager, routes, writeService, loginService }) {
  if (!PRODUCT_IDS.has(appId)) throw new TypeError('PRODUCT_API_ID_INVALID');
  if (typeof authenticate !== 'function') throw new TypeError('PRODUCT_AUTHENTICATOR_REQUIRED');
  if (!registry || typeof registry.findTenantById !== 'function') throw new TypeError('PRODUCT_TENANT_REGISTRY_REQUIRED');
  if (!secretProvider || typeof secretProvider.getDatabaseCredentials !== 'function') throw new TypeError('PRODUCT_SECRET_PROVIDER_REQUIRED');
  if (!poolManager || typeof poolManager.getPool !== 'function') throw new TypeError('PRODUCT_POOL_MANAGER_REQUIRED');
  if (writeService !== undefined && (!writeService || typeof writeService.execute !== 'function')) throw new TypeError('PRODUCT_TENANT_WRITE_SERVICE_INVALID');
  if (loginService !== undefined && (!loginService || typeof loginService.login !== 'function' || typeof loginService.logout !== 'function')) throw new TypeError('PRODUCT_LOGIN_SERVICE_INVALID');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/health/live', (_req, res) => res.json({ ok: true, service: appId + '-api' }));

  app.post('/api/auth/login', asyncBoundary(async (req, res) => {
    if (!loginService) return res.status(503).json({ error: 'LOGIN_UNAVAILABLE' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const result = await loginService.login({
      host: req.hostname,
      username: body.username,
      password: body.password
    });
    return res.json(result);
  }));
  app.post('/api/auth/logout', asyncBoundary(async (req, res) => {
    if (!loginService) return res.status(503).json({ error: 'LOGOUT_UNAVAILABLE' });
    await new Promise((resolve, reject) => authenticate(req, res, error => error ? reject(error) : resolve()));
    return res.json(await loginService.logout(req.auth));
  }));

  const resolveTenant = createTenantMiddleware({ appId, registry, secretProvider, poolManager });
  const api = express.Router();
  api.use(asyncBoundary(async (req, res, next) => authenticate(req, res, next)));
  api.use(resolveTenant);
  api.use((req, _res, next) => {
    try {
      req.tenantRepository = createTenantRepository({ pool: req.tenantDb, appId });
      if (writeService) {
        req.tenantWrite = input => writeService.execute({
          ...input, auth: req.auth, tenantContext: req.tenantContext, repository: req.tenantRepository
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });
  api.get('/tenant-context', (req, res) => res.json({
    appId: req.tenantContext.appId,
    tenantId: req.tenantContext.tenantId,
    schemaVersion: req.tenantContext.schemaVersion
  }));
  if (routes !== undefined) {
    if (typeof routes !== 'function') throw new TypeError('PRODUCT_ROUTES_MUST_BE_A_ROUTER_FACTORY');
    const productRouter = routes({ appId });
    if (!productRouter || typeof productRouter !== 'function') throw new TypeError('PRODUCT_ROUTER_INVALID');
    api.use(productRouter);
  }
  app.use('/api', api);
  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    if (status >= 500) req.log?.error?.({ errorName: err.name, errorCode: err.code, requestId: req.id }, 'product API request failed');
    const publicCode = typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code) ? err.code : 'REQUEST_FAILED';
    res.status(status).json({ error: status >= 500 ? 'INTERNAL_ERROR' : publicCode });
  });
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}

module.exports = { PRODUCT_IDS, createProductApi };
