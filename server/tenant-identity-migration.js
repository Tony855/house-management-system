'use strict';

const crypto = require('node:crypto');
const { APP_IDS } = require('./tenant-registry');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLES = Object.freeze(['users', 'roles', 'settings', 'user_permissions', 'role_permissions']);
const MAX_ROWS = 100000;
function canonical(v) { if (Array.isArray(v)) return v.map(canonical); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])); return v; }
function digest(rows) { return crypto.createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex'); }
function normalizeTenantIdentity({ appId, tenantId, sourceOrgId, snapshot }) {
  if (!APP_IDS.has(appId) || !UUID_RE.test(tenantId || '') || !Number.isSafeInteger(sourceOrgId) || sourceOrgId < 1) throw new TypeError('TENANT_IDENTITY_MIGRATION_IDENTITY_INVALID');
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('TENANT_IDENTITY_MIGRATION_SNAPSHOT_INVALID');
  for (const table of TABLES) if (!Array.isArray(snapshot[table]) || snapshot[table].length > MAX_ROWS || snapshot[table].some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('TENANT_IDENTITY_MIGRATION_TABLE_INVALID');
  const users = snapshot.users.map(row => {
    if (Number(row.org_id) !== sourceOrgId || row.mode !== appId || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1 || typeof row.username !== 'string' || !row.username || typeof row.password !== 'string' || !row.password) throw new Error('TENANT_IDENTITY_MIGRATION_USER_SCOPE_INVALID');
    const { org_id: _org, mode: _mode, ...copy } = row; return { ...copy, mode: appId };
  });
  const userIds = new Set(users.map(r => String(r.id)));
  if (userIds.size !== users.length) throw new Error('TENANT_IDENTITY_MIGRATION_DUPLICATE_USER');
  const codes = new Set(users.map(r => r.role).filter(Boolean));
  const roles = snapshot.roles.filter(r => (r.org_id === null || Number(r.org_id) === sourceOrgId) && codes.has(r.code));
  for (const code of codes) if (!roles.some(r => r.code === code)) throw new Error('TENANT_IDENTITY_MIGRATION_ROLE_MISSING');
  const roleIds = new Set(roles.map(r => String(r.id)));
  const cleanRoles = roles.map(({ org_id: _org, ...r }) => r);
  const userPermissions = snapshot.user_permissions.filter(r => userIds.has(String(r.user_id)));
  const byRole = new Map();
  for (const r of snapshot.role_permissions) {
    if (!roleIds.has(String(r.role_id))) continue;
    const org = Number(r.org_id); if (org !== 0 && org !== sourceOrgId) continue;
    const k = String(r.role_id); if (!byRole.has(k)) byRole.set(k, { defaults: [], overrides: [] });
    byRole.get(k)[org === sourceOrgId ? 'overrides' : 'defaults'].push(String(r.page));
  }
  const rolePermissions = [];
  for (const id of roleIds) { const v = byRole.get(id); if (!v) continue; for (const page of [...new Set(v.overrides.length ? v.overrides : v.defaults)].sort()) rolePermissions.push({ role_id: Number(id), page }); }
  const settingRows = snapshot.settings.filter(r => Number(r.org_id) === sourceOrgId);
  if (settingRows.length !== 1) throw new Error('TENANT_IDENTITY_MIGRATION_SETTINGS_INVALID');
  const settings = settingRows.map(({ org_id: _org, ...r }) => r);
  const tables = { users, roles: cleanRoles, settings, user_permissions: userPermissions, role_permissions: rolePermissions };
  const manifest = Object.fromEntries(TABLES.map(t => [t, { rowCount: tables[t].length, sha256: digest(tables[t]) }]));
  return { tables, manifest, revokedLegacySessions: Number(snapshot.legacySessionCount || 0) };
}
async function copyTenantIdentity({ appId, tenantId, sourceOrgId, sourceReader, targetWriter, targetReader, audit, mode = 'dry-run' }) {
  if (!['dry-run', 'copy'].includes(mode)) throw new TypeError('TENANT_IDENTITY_MIGRATION_MODE_INVALID');
  if (!sourceReader || typeof sourceReader.exportTenantIdentity !== 'function') throw new TypeError('TENANT_IDENTITY_MIGRATION_SOURCE_REQUIRED');
  if (typeof audit !== 'function') throw new TypeError('TENANT_IDENTITY_MIGRATION_AUDIT_REQUIRED');
  if (mode === 'copy' && (!targetWriter || typeof targetWriter.importTenantIdentity !== 'function' || !targetReader || typeof targetReader.readTenantIdentity !== 'function')) throw new TypeError('TENANT_IDENTITY_MIGRATION_TARGET_REQUIRED');
  await audit({ event: 'tenant_identity_migration_started', appId, tenantId, sourceOrgId, mode });
  const source = await sourceReader.exportTenantIdentity({ appId, tenantId, sourceOrgId });
  const normalized = normalizeTenantIdentity({ appId, tenantId, sourceOrgId, snapshot: source });
  if (mode === 'dry-run') { await audit({ event: 'tenant_identity_migration_dry_run_verified', appId, tenantId, sourceOrgId, manifest: normalized.manifest }); return { mode, appId, tenantId, sourceOrgId, manifest: normalized.manifest, copied: false, revokedLegacySessions: normalized.revokedLegacySessions }; }
  try {
    await targetWriter.importTenantIdentity({ appId, tenantId, tables: normalized.tables });
    const actual = await targetReader.readTenantIdentity({ appId, tenantId });
    if (!actual || !actual.tables || !TABLES.every(t => Array.isArray(actual.tables[t]) && actual.tables[t].length === normalized.manifest[t].rowCount && digest(actual.tables[t]) === normalized.manifest[t].sha256)) throw Object.assign(new Error('TENANT_IDENTITY_MIGRATION_RECONCILIATION_FAILED'), { code: 'TENANT_IDENTITY_MIGRATION_RECONCILIATION_FAILED' });
    await audit({ event: 'tenant_identity_migration_copy_verified', appId, tenantId, sourceOrgId, manifest: normalized.manifest });
    return { mode, appId, tenantId, sourceOrgId, manifest: normalized.manifest, copied: true, revokedLegacySessions: normalized.revokedLegacySessions };
  } catch (error) { try { await audit({ event: 'tenant_identity_migration_copy_failed', appId, tenantId, sourceOrgId, code: /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || '') ? error.code : 'TENANT_IDENTITY_MIGRATION_FAILED' }); } catch (auditError) { error.auditFailure = auditError.code || auditError.message || 'AUDIT_WRITE_FAILED'; } throw error; }
}
module.exports = { TABLES, digest, normalizeTenantIdentity, copyTenantIdentity };
