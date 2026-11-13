'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_IDS = new Set(['rental', 'hotel', 'property']);

class TenantResolutionError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = 'TenantResolutionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve only from a verified authentication context. Never pass req.body,
 * query params, localStorage values or an arbitrary X-Tenant-ID header here.
 * registry.findTenantById must query the isolated platform registry.
 */
async function resolveTenantContext({ auth, appId, registry, secretProvider }) {
  if (!auth || auth.authenticated !== true) throw new TenantResolutionError('AUTH_REQUIRED', 401);
  if (!APP_IDS.has(appId) || auth.appId !== appId) throw new TenantResolutionError('APP_AUDIENCE_MISMATCH');
  const tenantId = auth.tenantId;
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new TenantResolutionError('TENANT_CONTEXT_INVALID');
  }
  if (!registry || typeof registry.findTenantById !== 'function') {
    throw new TenantResolutionError('TENANT_REGISTRY_UNAVAILABLE', 503);
  }
  const tenant = await registry.findTenantById(tenantId);
  if (!tenant || tenant.tenant_uuid !== tenantId) throw new TenantResolutionError('TENANT_NOT_FOUND', 404);
  if (tenant.app_id !== appId) throw new TenantResolutionError('TENANT_APP_MISMATCH');
  if (tenant.lifecycle_state !== 'active') throw new TenantResolutionError('TENANT_NOT_ACTIVE', 423);
  if (!tenant.db_host || !tenant.db_name || !tenant.db_secret_ref ||
      !Number.isInteger(Number(tenant.db_port)) || Number(tenant.db_port) < 1 || Number(tenant.db_port) > 65535) {
    throw new TenantResolutionError('TENANT_DATABASE_MAPPING_INVALID', 503);
  }
  if (!secretProvider || typeof secretProvider.getDatabaseCredentials !== 'function') {
    throw new TenantResolutionError('TENANT_SECRET_PROVIDER_UNAVAILABLE', 503);
  }
  const credentials = await secretProvider.getDatabaseCredentials(tenant.db_secret_ref);
  if (!credentials || typeof credentials.user !== 'string' || !credentials.user ||
      typeof credentials.password !== 'string' || !credentials.password) {
    throw new TenantResolutionError('TENANT_DATABASE_CREDENTIALS_UNAVAILABLE', 503);
  }
  return Object.freeze({
    tenantId,
    appId,
    db: Object.freeze({
      host: tenant.db_host,
      port: Number(tenant.db_port),
      database: tenant.db_name,
      user: credentials.user,
      password: credentials.password,
      credentialVersion: String(credentials.version || credentials.updatedAt || '')
    }),
    schemaVersion: tenant.schema_version || null
  });
}

module.exports = { APP_IDS, TenantResolutionError, resolveTenantContext };
