'use strict';

const { resolveTenantContext } = require('./tenant-registry');

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
      const status = Number.isInteger(error.status) ? error.status : 503;
      return res.status(status).json({ error: error.code || 'TENANT_CONTEXT_UNAVAILABLE' });
    }
  };
}

module.exports = { createTenantMiddleware };
