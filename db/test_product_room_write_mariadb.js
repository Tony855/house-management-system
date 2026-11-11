'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql2/promise');
const { TenantPoolManager } = require('../server/tenant-db');
const { tenantDatabaseName } = require('../server/tenant-provisioner');
const { TABLES } = require('../server/tenant-repository');
const { createTenantWriteService } = require('../server/tenant-write-service');
const { createMariaDbTenantWriteIdempotencyStore } = require('../server/tenant-write-idempotency-mariadb');
const { createRentalApi } = require('../services/rental-api/app');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');

const APPS = Object.freeze({
  rental: { create: createRentalApi, room: { building_id: 1, room_no: 'CI-R-101', rent: 120, deposit: 50 } },
  hotel: { create: createHotelApi, room: { building_id: 1, room_no: 'CI-H-101', day_price: 60, deposit: 20, status: 'booked' } },
  property: { create: createPropertyApi, room: { building_id: 1, room_no: 'CI-P-101', owner_id: 1, property_fee: 100, water_price: 2, elec_price: 1.5 } }
});

async function createTenantDb(adminPool, config, appId, tenantId, created, createdUsers) {
  const source = 'house_sys_' + appId;
  const database = tenantDatabaseName(appId, tenantId);
  await adminPool.execute('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  created.push(database);
  const tables = [...TABLES[appId]].sort();
  for (const table of tables) {
    await adminPool.execute('CREATE TABLE `' + database + '`.`' + table + '` LIKE `' + source + '`.`' + table + '`');
    await adminPool.execute('ALTER TABLE `' + database + '`.`' + table + '` DROP COLUMN `org_id`');
  }
  const pool = mysql.createPool({ ...config, database, connectionLimit: 8 });
  await pool.execute(`CREATE TABLE tenant_write_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    app_id VARCHAR(16) NOT NULL, tenant_uuid CHAR(36) NOT NULL, user_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(128) NOT NULL, operation VARCHAR(16) NOT NULL, reason VARCHAR(500) NOT NULL,
    request_id VARCHAR(128) NOT NULL, event VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_tenant_write_audit_request (request_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'migrations/tenant/002_tenant_write_idempotency.sql'), 'utf8'));
  await pool.execute('INSERT INTO buildings (name, address, remark) VALUES (?, ?, ?)', ['CI integration building', '', 'temporary']);
  if (appId === 'property') {
    await pool.execute('INSERT INTO tenants (name, contact, phone, license_no, remark) VALUES (?, ?, ?, ?, ?)', ['CI property owner', '', '', '', 'temporary']);
  }
  const dbUser = 't_' + tenantId.replace(/-/g, '').slice(0, 24);
  const dbPassword = crypto.randomBytes(24).toString('base64url');
  await adminPool.query('CREATE USER ' + mysql.escapeId(dbUser) + '@\'%\' IDENTIFIED BY ?', [dbPassword]);
  await adminPool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + mysql.escapeId(database) + '.* TO ' + mysql.escapeId(dbUser) + '@\'%\'');
  createdUsers.push(dbUser);
  return { pool, credentials: { user: dbUser, password: dbPassword } };
}

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

async function post(base, room, requestId) {
  return fetch(base + '/api/rooms', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-operation-reason': 'CI approved room creation',
      'x-step-up-token': 'ci-step-up-token-123456789',
      'idempotency-key': requestId
    },
    body: JSON.stringify(room)
  });
}

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('PRODUCT_ROOM_WRITE_MARIADB_TEST_ONLY');
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 8,
    multipleStatements: false
  };
  const adminPool = mysql.createPool({ ...config, connectionLimit: 4 });
  const created = [];
  const createdUsers = [];
  const pools = [];
  const managers = [];
  const servers = [];
  try {
    for (const [appId, definition] of Object.entries(APPS)) {
      const tenantId = crypto.randomUUID();
      const tenantDb = await createTenantDb(adminPool, config, appId, tenantId, created, createdUsers);
      const pool = tenantDb.pool;
      pools.push(pool);
      const runtimeCredentials = tenantDb.credentials;
      const runtimeProbe = await mysql.createConnection({ ...config, ...runtimeCredentials, database: tenantDatabaseName(appId, tenantId) });
      try {
        const [[ownDb]] = await runtimeProbe.query('SELECT DATABASE() AS dbName');
        assert.equal(ownDb.dbName, tenantDatabaseName(appId, tenantId), appId + ' tenant principal database scope');
        await assert.rejects(runtimeProbe.query('SELECT id FROM `house_sys_' + appId + '`.`buildings`'), appId + ' legacy shared DB denied');
        await assert.rejects(runtimeProbe.query('CREATE TABLE tenant_ddl_must_be_denied (id INT)'), appId + ' DDL denied');
      } finally { await runtimeProbe.end(); }
      const poolManager = new TenantPoolManager({ createPool: options => mysql.createPool(options), maxPools: 2 });
      managers.push(poolManager);
      let failCommitAudit = false;
      const writeService = createTenantWriteService({
        authorize: async ({ auth, tenantContext }) => auth.tenantId === tenantContext.tenantId && auth.appId === appId,
        verifyStepUp: async ({ token }) => token === 'ci-step-up-token-123456789',
        auditWriter: {
          async append(tx, event) {
            if (failCommitAudit && event.event === 'tenant_write_committed') throw new Error('CI_AUDIT_FAILURE');
            await tx.execute(
              'INSERT INTO tenant_write_audit (app_id, tenant_uuid, user_id, session_id, operation, reason, request_id, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [event.appId, event.tenantId, event.userId, event.sessionId, event.operation, event.reason, event.requestId, event.event]
            );
          }
        },
        idempotencyStore: createMariaDbTenantWriteIdempotencyStore()
      });
      const app = definition.create({
        appId,
        authenticate(req, _res, next) {
          req.auth = { authenticated: true, appId, tenantId, userId: 'ci-user', sessionId: 'ci-session-' + appId };
          next();
        },
        registry: {
          async findTenantById(id) {
            return id === tenantId ? {
              tenant_uuid: tenantId, app_id: appId, lifecycle_state: 'active',
              db_host: config.host, db_port: config.port, db_name: tenantDatabaseName(appId, tenantId),
              db_secret_ref: 'ci/' + tenantId, schema_version: 'ci'
            } : null;
          }
        },
        secretProvider: { async getDatabaseCredentials() { return { ...runtimeCredentials, version: 'ci' }; } },
        poolManager,
        writeService
      });
      const endpoint = await startServer(app);
      servers.push(endpoint.server);
      const base = endpoint.base;
      const room = { ...definition.room };
      const requestId = 'ci-room-create-' + appId + '-000001';

      const [first, replay] = await Promise.all([
        post(base, room, requestId),
        post(base, room, requestId)
      ]);
      assert.equal(first.status, 201, appId + ' first create');
      assert.equal(replay.status, 201, appId + ' idempotent replay');
      const firstBody = await first.json();
      const replayBody = await replay.json();
      assert.equal(firstBody.id, replayBody.id, appId + ' replay ID');
      const [[countRows]] = await pool.query('SELECT COUNT(*) AS total FROM rooms WHERE room_no = ?', [room.room_no]);
      assert.equal(Number(countRows.total), 1, appId + ' concurrent duplicate mutation');

      const changed = { ...room, room_no: room.room_no + '-changed' };
      const conflict = await post(base, changed, requestId);
      assert.equal(conflict.status, 409, appId + ' idempotency payload conflict');

      const duplicate = await post(base, room, 'ci-room-duplicate-' + appId + '-0001');
      assert.equal(duplicate.status, 409, appId + ' duplicate room key');

      const missingBuilding = await post(base, { ...room, building_id: 999999 }, 'ci-room-missing-building-' + appId);
      assert.equal(missingBuilding.status, 404, appId + ' missing building');

      failCommitAudit = true;
      const auditFailureRoom = { ...room, room_no: room.room_no + '-audit-failure' };
      const auditFailure = await post(base, auditFailureRoom, 'ci-room-audit-failure-' + appId);
      assert.equal(auditFailure.status, 500, appId + ' audit failure status');
      failCommitAudit = false;
      const [[rolledBackRows]] = await pool.query('SELECT COUNT(*) AS total FROM rooms WHERE room_no = ?', [auditFailureRoom.room_no]);
      assert.equal(Number(rolledBackRows.total), 0, appId + ' audit failure rollback');

      if (appId === 'property') {
        const noOwner = await post(base, { ...room, room_no: 'CI-P-NO-OWNER', owner_id: 999999 }, 'ci-room-missing-owner-property');
        assert.equal(noOwner.status, 404, 'property missing owner');
      }
      console.log('PASS: ' + appId + ' MariaDB write, concurrent idempotency, replay, conflict, duplicate, validation and audit rollback');
    }
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const manager of managers) await manager.closeAll();
    for (const pool of pools) await pool.end();
    for (const user of createdUsers) {
      try { await adminPool.query('DROP USER IF EXISTS ' + mysql.escapeId(user) + '@\'%\''); } catch (_) {}
    }
    for (const database of created) {
      try { await adminPool.execute('DROP DATABASE `' + database + '`'); } catch (_) {}
    }
    await adminPool.end();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || 'PRODUCT_ROOM_WRITE_MARIADB_TEST_FAILED');
  process.exitCode = 1;
});
