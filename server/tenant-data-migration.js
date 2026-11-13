'use strict';

const crypto = require('node:crypto');
const { APP_IDS } = require('./tenant-registry');
const { TABLES } = require('./tenant-repository');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ROWS_PER_TABLE = 250000;
const RELATIONSHIPS = Object.freeze({
  rental: Object.freeze([
    ['rooms', 'building_id', 'buildings'], ['contracts', 'room_id', 'rooms'], ['contracts', 'tenant_id', 'tenants'],
    ['meters', 'room_id', 'rooms'], ['room_net_lines', 'room_id', 'rooms'], ['net_changes', 'room_id', 'rooms'], ['net_changes', 'line_id', 'room_net_lines'],
    ['net_requests', 'room_id', 'rooms'], ['net_requests', 'line_id', 'room_net_lines'],
    ['bills', 'room_id', 'rooms'], ['bills', 'tenant_id', 'tenants'], ['bills', 'contract_id', 'contracts'],
    ['repairs', 'room_id', 'rooms']
  ]),
  hotel: Object.freeze([
    ['rooms', 'building_id', 'buildings'], ['orders', 'room_id', 'rooms'], ['orders', 'guest_id', 'tenants'],
    ['bills', 'room_id', 'rooms'], ['bills', 'tenant_id', 'tenants'], ['bills', 'order_id', 'orders'],
    ['repairs', 'room_id', 'rooms']
  ]),
  property: Object.freeze([
    ['rooms', 'building_id', 'buildings'], ['org_employees', 'room_id', 'rooms'], ['meters', 'room_id', 'rooms'],
    ['room_net_lines', 'room_id', 'rooms'], ['net_changes', 'room_id', 'rooms'], ['net_changes', 'line_id', 'room_net_lines'],
    ['net_requests', 'room_id', 'rooms'], ['net_requests', 'line_id', 'room_net_lines'],
    ['bills', 'room_id', 'rooms'], ['bills', 'tenant_id', 'tenants'],
    ['repairs', 'room_id', 'rooms'], ['complaints', 'room_id', 'rooms']
  ])
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function digestRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(rows))).digest('hex');
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('TENANT_MIGRATION_JOB_LEASE_LOST'), { code: 'TENANT_MIGRATION_JOB_LEASE_LOST' });
}

function validateIdentity({ appId, tenantId, sourceOrgId }) {
  if (!APP_IDS.has(appId) || !UUID_RE.test(tenantId) ||
      !Number.isSafeInteger(sourceOrgId) || sourceOrgId < 1) {
    throw new TypeError('TENANT_DATA_MIGRATION_IDENTITY_INVALID');
  }
}

function normalizeSourceSnapshot(appId, sourceOrgId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new TypeError('TENANT_DATA_MIGRATION_SNAPSHOT_INVALID');
  }
  const expectedTables = [...TABLES[appId]].sort();
  const actualTables = Object.keys(snapshot.tables).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new Error('TENANT_DATA_MIGRATION_TABLE_SET_MISMATCH');
  }

  const tables = {};
  const manifest = {};
  for (const table of expectedTables) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE) {
      throw new Error('TENANT_DATA_MIGRATION_TABLE_ROWS_INVALID');
    }
    const tenantRows = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          !Number.isSafeInteger(Number(row.org_id)) || Number(row.org_id) !== sourceOrgId) {
        throw new Error('TENANT_DATA_MIGRATION_SOURCE_SCOPE_MISMATCH');
      }
      const { org_id: _orgId, ...tenantRow } = row;
      return tenantRow;
    });
    tables[table] = tenantRows;
    manifest[table] = { rowCount: tenantRows.length, sha256: digestRows(tenantRows) };
  }
  const ids = Object.fromEntries(expectedTables.map(table => [
    table, new Set((tables[table] || []).map(row => String(row.id)))
  ]));
  for (const [table, column, referencedTable] of RELATIONSHIPS[appId]) {
    for (const row of tables[table]) {
      const value = row[column];
      if (value !== null && value !== undefined && value !== '' && !ids[referencedTable].has(String(value))) {
        throw new Error('TENANT_DATA_MIGRATION_RELATIONSHIP_INVALID');
      }
    }
  }
  return { tables, manifest };
}

function compareManifests(expected, actual) {
  if (!actual || typeof actual !== 'object') return false;
  const expectedTables = Object.keys(expected).sort();
  const actualTables = Object.keys(actual).sort();
  if (JSON.stringify(expectedTables) !== JSON.stringify(actualTables)) return false;
  return expectedTables.every(table =>
    Number(actual[table]?.rowCount) === expected[table].rowCount &&
    actual[table]?.sha256 === expected[table].sha256
  );
}

/**
 * Copies one legacy org into an already-provisioned tenant database.
 * This operation is deliberately non-destructive: it never deletes source rows,
 * changes legacy routing, or performs cutover. The target writer must use one
 * transaction for the complete snapshot and reject duplicate/partial imports.
 */
async function copyTenantOrgData({
  appId, tenantId, sourceOrgId, sourceReader, targetWriter, targetReader, audit,
  mode = 'dry-run', signal
}) {
  validateIdentity({ appId, tenantId, sourceOrgId });
  if (!['dry-run', 'copy'].includes(mode)) throw new TypeError('TENANT_DATA_MIGRATION_MODE_INVALID');
  if (!sourceReader || typeof sourceReader.exportOrgSnapshot !== 'function') {
    throw new TypeError('TENANT_DATA_MIGRATION_SOURCE_REQUIRED');
  }
  if (typeof audit !== 'function') throw new TypeError('TENANT_DATA_MIGRATION_AUDIT_REQUIRED');
  if (mode === 'copy' && (!targetWriter || typeof targetWriter.importTenantSnapshot !== 'function' ||
      !targetReader || typeof targetReader.readTenantSnapshot !== 'function')) {
    throw new TypeError('TENANT_DATA_MIGRATION_TARGET_REQUIRED');
  }

  let normalized;
  try {
    assertNotAborted(signal);
    await audit({ event: 'tenant_data_migration_started', appId, tenantId, sourceOrgId, mode });
    assertNotAborted(signal);
    const source = await sourceReader.exportOrgSnapshot({ appId, sourceOrgId, signal });
    assertNotAborted(signal);
    normalized = normalizeSourceSnapshot(appId, sourceOrgId, source);
    if (mode === 'dry-run') {
      await audit({ event: 'tenant_data_migration_dry_run_verified', appId, tenantId, sourceOrgId, manifest: normalized.manifest });
      return { mode, appId, tenantId, sourceOrgId, manifest: normalized.manifest, copied: false, cutover: false };
    }
  } catch (error) {
    try {
      await audit({
        event: 'tenant_data_migration_failed',
        appId, tenantId, sourceOrgId,
        code: /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || '') ? error.code : 'TENANT_DATA_MIGRATION_FAILED'
      });
    } catch (auditError) {
      error.auditFailure = auditError.code || auditError.message || 'AUDIT_WRITE_FAILED';
    }
    throw error;
  }

  try {
    // A previous attempt may have committed the tenant transaction but lost its
    // final audit acknowledgement. Reconcile an existing target before writing
    // so the operator can safely retry without duplicating or overwriting rows.
    assertNotAborted(signal);
    let target = await targetReader.readTenantSnapshot({ appId, tenantId, signal });
    assertNotAborted(signal);
    let targetNormalized = normalizeTargetSnapshot(appId, target);
    let alreadyImported = compareManifests(normalized.manifest, targetNormalized.manifest);

    if (!alreadyImported) {
      const targetHasRows = Object.values(targetNormalized.manifest).some(item => item.rowCount > 0);
      if (targetHasRows) {
        const error = new Error('TENANT_DATA_MIGRATION_TARGET_NOT_EMPTY');
        error.code = 'TENANT_DATA_MIGRATION_TARGET_NOT_EMPTY';
        throw error;
      }

      try {
        assertNotAborted(signal);
        await targetWriter.importTenantSnapshot({ appId, tenantId, tables: normalized.tables, signal });
        assertNotAborted(signal);
      } catch (writeError) {
        // Another worker may have won the advisory lock and committed the same
        // snapshot. Accept only an exact manifest match; all other failures stay
        // fail-closed and are surfaced to the operator.
        if (writeError.message !== 'TENANT_DATA_MIGRATION_TARGET_NOT_EMPTY') throw writeError;
        target = await targetReader.readTenantSnapshot({ appId, tenantId, signal });
        assertNotAborted(signal);
        targetNormalized = normalizeTargetSnapshot(appId, target);
        if (!compareManifests(normalized.manifest, targetNormalized.manifest)) throw writeError;
        alreadyImported = true;
      }

      if (!alreadyImported) {
        target = await targetReader.readTenantSnapshot({ appId, tenantId, signal });
        assertNotAborted(signal);
        targetNormalized = normalizeTargetSnapshot(appId, target);
        if (!compareManifests(normalized.manifest, targetNormalized.manifest)) {
          const error = new Error('TENANT_DATA_MIGRATION_RECONCILIATION_FAILED');
          error.code = 'TENANT_DATA_MIGRATION_RECONCILIATION_FAILED';
          throw error;
        }
      }
    }

    await audit({ event: 'tenant_data_migration_copy_verified', appId, tenantId, sourceOrgId, manifest: normalized.manifest });
    return { mode, appId, tenantId, sourceOrgId, manifest: normalized.manifest, copied: true, alreadyImported, cutover: false };
  } catch (error) {
    try {
      await audit({
        event: 'tenant_data_migration_failed',
        appId,
        tenantId,
        sourceOrgId,
        code: /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || '') ? error.code : 'TENANT_DATA_MIGRATION_FAILED'
      });
    } catch (auditError) {
      error.auditFailure = auditError.code || auditError.message || 'AUDIT_WRITE_FAILED';
    }
    throw error;
  }
}

function normalizeTargetSnapshot(appId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new TypeError('TENANT_DATA_MIGRATION_TARGET_SNAPSHOT_INVALID');
  }
  const expectedTables = [...TABLES[appId]].sort();
  const actualTables = Object.keys(snapshot.tables).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new Error('TENANT_DATA_MIGRATION_TARGET_TABLE_SET_MISMATCH');
  }
  const manifest = {};
  for (const table of expectedTables) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE ||
        rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.hasOwn(row, 'org_id'))) {
      throw new Error('TENANT_DATA_MIGRATION_TARGET_ROWS_INVALID');
    }
    manifest[table] = { rowCount: rows.length, sha256: digestRows(rows) };
  }
  return { manifest };
}

module.exports = { copyTenantOrgData, digestRows, normalizeSourceSnapshot, compareManifests, RELATIONSHIPS };
