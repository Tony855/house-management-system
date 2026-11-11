'use strict';

const { resolveTenantContext } = require('./tenant-registry');

function publicErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'TENANT_CONTEXT_UNAVAILABLE';
}

/**
 * appId is supplied by the API service configuration, never by request input.
 * req.auth must be populated by the product-specific JWT/session verifier.
 */
function createTenantMiddleware({ appId, registry, secretProvider, poolManager }) {
  if (!poolManager || typeof poolManager.getPool !== 'function') throw new TypeError('poolManager is required');
  return async function tenantMiddleware(req, res, next) {
    try {
      const context = await resolveTenantContext({
        auth: req.auth,
        appId,
        registry,
        secretProvider
      });
      const tenantPool = await poolManager.getPool(context);
      req.tenantContext = Object.freeze({
        tenantId: context.tenantId,
        appId: context.appId,
        schemaVersion: context.schemaVersion
      });
      req.tenantDb = tenantPool;
      return next();
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      return res.status(status).json({ error: publicErrorCode(error) });
    }
  };
}

module.exports = { createTenantMiddleware };
