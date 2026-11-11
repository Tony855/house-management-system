'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { createMariaDbTenantIdentityAdapters } = require('../server/tenant-identity-migration-mariadb');
const { copyTenantIdentity } = require('../server/tenant-identity-migration');
const { tenantDatabaseName } = require('../server/tenant-provisioner');

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('TENANT_IDENTITY_MARIADB_TEST_ONLY');
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 6,
    multipleStatements: false,
    dateStrings: true
  };
  const admin = mysql.createPool(config);
  const source = mysql.createPool({ ...config, database: 'house_sys' });
  const created = [];
  const targets = [];
  const roleIds = [];
  const userIds = [];
  const orgIds = [];
  const tokens = [];
  try {
    const suffix = crypto.randomBytes(5).toString('hex');
    const appId = 'rental';
    const orgA = crypto.randomInt(300000000, 400000000);
    const orgB = orgA + 1;
    orgIds.push(orgA, orgB);
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const code = 'staff_' + suffix;
    const username = 'same-user-' + suffix;

    const [tenantRole] = await source.execute(
      'INSERT INTO roles (org_id, code, name, description, level, is_system) VALUES (?, ?, ?, ?, ?, ?)',
      [orgA, code, 'Tenant staff', '', 'staff', 0]
    );
    const [globalRole] = await source.execute(
      'INSERT INTO roles (org_id, code, name, description, level, is_system) VALUES (NULL, ?, ?, ?, ?, ?)',
      [code, 'Global staff', '', 'staff', 1]
    );
    roleIds.push(tenantRole.insertId, globalRole.insertId);

    for (const orgId of orgIds) {
      const [user] = await source.execute(
        'INSERT INTO users (username, password, real_name, role, mode, org_id) VALUES (?, ?, ?, ?, ?, ?)',
        [username, '$2b$12$opaque-test-hash', 'CI identity', code, appId, orgId]
      );
      userIds.push(user.insertId);
      await source.execute(
        'INSERT INTO settings (org_id, currency, rate, net_price_per_mb, water_price, elec_price) VALUES (?, ?, ?, ?, ?, ?)',
        [orgId, 'USD', 7.2, 1, 4.5, 1]
      );
      await source.execute('INSERT INTO user_permissions (user_id, page) VALUES (?, ?)', [user.insertId, 'rooms']);
      const token = crypto.randomBytes(32).toString('hex');
      tokens.push(token);
      await source.execute('INSERT INTO sessions (token, user_id, mode, org_id) VALUES (?, ?, ?, ?)', [token, user.insertId, appId, orgId]);
    }
    await source.execute('INSERT INTO role_permissions (role_id, org_id, page) VALUES (?, 0, ?)', [globalRole.insertId, 'rooms']);
    await source.execute('INSERT INTO role_permissions (role_id, org_id, page) VALUES (?, ?, ?)', [tenantRole.insertId, orgA, 'dashboard']);

    const sql = fs.readFileSync(path.join(__dirname, 'migrations/tenant/001_tenant_identity.sql'), 'utf8');
    const dbA = tenantDatabaseName(appId, tenantA);
    const dbB = tenantDatabaseName(appId, tenantB);
    for (const db of [dbA, dbB]) {
      await admin.execute('CREATE DATABASE `' + db + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      created.push(db);
      const setup = mysql.createPool({ ...config, database: db, multipleStatements: true });
      try { await setup.query(sql); } finally { await setup.end(); }
    }
    const targetA = mysql.createPool({ ...config, database: tenantDatabaseName(appId, tenantA) });
    const targetB = mysql.createPool({ ...config, database: tenantDatabaseName(appId, tenantB) });
    targets.push(targetA, targetB);

    const run = async (tenantId, orgId, targetPool) => {
      const adapters = createMariaDbTenantIdentityAdapters({ sourcePool: source, targetPool, tenantId });
      return copyTenantIdentity({
        appId, tenantId, sourceOrgId: orgId, mode: 'copy', ...adapters,
        audit: async () => {}
      });
    };
    const [resultA, resultB] = await Promise.all([
      run(tenantA, orgA, targetA),
      run(tenantB, orgB, targetB)
    ]);
    if (!resultA.copied || !resultB.copied || resultA.revokedLegacySessions !== 1 || resultB.revokedLegacySessions !== 1) {
      throw new Error('TENANT_IDENTITY_MARIADB_COPY_INVALID');
    }
    const [[usersA], [usersB], [rolesA], [rolesB], [permsA], [permsB], [sessionsA], [sessionsB]] = await Promise.all([
      targetA.execute('SELECT id, username, password, role FROM users'),
      targetB.execute('SELECT id, username, password, role FROM users'),
      targetA.execute('SELECT id, code FROM roles'),
      targetB.execute('SELECT id, code FROM roles'),
      targetA.execute('SELECT role_id, page FROM role_permissions ORDER BY role_id, page'),
      targetB.execute('SELECT role_id, page FROM role_permissions ORDER BY role_id, page'),
      targetA.execute("SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'"),
      targetB.execute("SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'")
    ]);
    if (usersA.length !== 1 || usersB.length !== 1 || usersA[0].username !== usersB[0].username ||
        usersA[0].password !== '$2b$12$opaque-test-hash' || usersB[0].password !== usersA[0].password) {
      throw new Error('TENANT_IDENTITY_CROSS_TENANT_USER_ISOLATION_FAILED');
    }
    if (rolesA.length !== 1 || rolesB.length !== 1 || rolesA[0].id !== tenantRole.insertId || rolesB[0].id !== globalRole.insertId) {
      throw new Error('TENANT_IDENTITY_ROLE_PRECEDENCE_FAILED');
    }
    if (permsA.length !== 1 || permsA[0].page !== 'dashboard' || permsB.length !== 1 || permsB[0].page !== 'rooms') {
      throw new Error('TENANT_IDENTITY_EFFECTIVE_PERMISSION_FAILED');
    }
    if (Number(sessionsA[0].total) !== 0 || Number(sessionsB[0].total) !== 0) {
      throw new Error('TENANT_IDENTITY_LEGACY_SESSIONS_COPIED');
    }
    console.log('PASS: tenant identity MariaDB copy, same username isolation, tenant role precedence, default permissions and legacy session exclusion');
  } finally {
    for (const pool of targets) await pool.end();
    for (const token of tokens) { try { await source.execute('DELETE FROM sessions WHERE token = ?', [token]); } catch (_) {} }
    for (const id of userIds) { try { await source.execute('DELETE FROM user_permissions WHERE user_id = ?', [id]); await source.execute('DELETE FROM users WHERE id = ?', [id]); } catch (_) {} }
    for (const id of roleIds) {
      try { await source.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]); await source.execute('DELETE FROM roles WHERE id = ?', [id]); } catch (_) {}
    }
    for (const id of orgIds) { try { await source.execute('DELETE FROM settings WHERE org_id = ?', [id]); } catch (_) {} }
    for (const db of created) { try { await admin.execute('DROP DATABASE `' + db + '`'); } catch (_) {} }
    await source.end();
    await admin.end();
  }
}
main().catch(error => { console.error(error.code || error.message || 'TENANT_IDENTITY_MARIADB_TEST_FAILED'); process.exitCode = 1; });
