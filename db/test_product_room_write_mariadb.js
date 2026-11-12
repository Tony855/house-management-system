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
  rental: { create: createRentalApi, room: { building_id: 1, room_no: 'CI-R-101', rent: 120, deposit: 50, water_price: 2, elec_price: 1.5 } },
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
  await adminPool.query('CREATE USER ' + mysql.escape(dbUser) + '@' + mysql.escape('%') + ' IDENTIFIED BY ' + mysql.escape(dbPassword));
  await adminPool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + mysql.escapeId(database) + '.* TO ' + mysql.escape(dbUser) + '@' + mysql.escape('%'));
  createdUsers.push(dbUser);
  const [grantRows] = await adminPool.query('SHOW GRANTS FOR ' + mysql.escape(dbUser) + '@' + mysql.escape('%'));
  const grantText = grantRows.map(row => Object.values(row).join(' ')).join(' ').toUpperCase();
  assert.match(grantText, new RegExp('SELECT, INSERT, UPDATE, DELETE ON \\x60' + database.toUpperCase() + '\\x60\\.\\*'));
  assert.doesNotMatch(grantText, /ALL PRIVILEGES|GRANT OPTION/);
  const [[legacyColumns]] = await pool.query(
    "SELECT COUNT(*) AS total FROM information_schema.columns WHERE table_schema = ? AND table_name IN (" + tables.map(() => '?').join(',') + ") AND column_name = 'org_id'",
    [database, ...tables]
  );
  assert.equal(Number(legacyColumns.total), 0, appId + ' tenant schema excludes org_id');
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


async function hotelOrderRequest(base, method, path, body, requestId) {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-operation-reason': 'CI hotel reservation lifecycle', 'x-step-up-token': 'ci-step-up-token-123456789', 'idempotency-key': requestId }, body: JSON.stringify(body) });
}

async function writeBuilding(base, method, path, body, requestId) {
  return fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-operation-reason': 'CI approved building maintenance',
      'x-step-up-token': 'ci-step-up-token-123456789',
      'idempotency-key': requestId
    },
    body: JSON.stringify(body)
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
      const peerTenantId = crypto.randomUUID();
      const peerTenantDb = await createTenantDb(adminPool, config, appId, peerTenantId, created, createdUsers);
      pools.push(peerTenantDb.pool);
      await assert.rejects(
        mysql.createConnection({ ...config, ...tenantDb.credentials, database: tenantDatabaseName(appId, peerTenantId) }),
        /denied|access/i,
        appId + ' tenant principal cannot open a peer tenant database'
      );
      await assert.rejects(
        mysql.createConnection({ ...config, ...peerTenantDb.credentials, database: tenantDatabaseName(appId, tenantId) }),
        /denied|access/i,
        appId + ' peer tenant principal cannot open this tenant database'
      );
      const runtimeCredentials = tenantDb.credentials;
      const runtimeProbe = await mysql.createConnection({ ...config, ...runtimeCredentials, database: tenantDatabaseName(appId, tenantId) });
      try {
        const [[ownDb]] = await runtimeProbe.query('SELECT DATABASE() AS dbName');
        assert.equal(ownDb.dbName, tenantDatabaseName(appId, tenantId), appId + ' tenant principal database scope');
        await assert.rejects(runtimeProbe.query('SELECT id FROM `house_sys_' + appId + '`.`buildings`'), /denied/i);
        await assert.rejects(runtimeProbe.query('CREATE TABLE tenant_ddl_must_be_denied (id INT)'), /denied/i);
      } finally { await runtimeProbe.end(); }
      const poolManager = new TenantPoolManager({ createPool: options => mysql.createPool(options), maxPools: 2 });
      managers.push(poolManager);
      let failCommitAudit = false;
      let denyAuthorization = false;
      let denyStepUp = false;
      const writeService = createTenantWriteService({
        authorize: async ({ auth, tenantContext }) => !denyAuthorization && auth.tenantId === tenantContext.tenantId && auth.appId === appId,
        verifyStepUp: async ({ token }) => !denyStepUp && token === 'ci-step-up-token-123456789',
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
      const buildingName = 'CI-WRITE-' + appId.toUpperCase();
      const buildingRequestId = 'ci-building-create-' + appId + '-0001';
      const buildingCreated = await writeBuilding(base, 'POST', '/api/buildings', {
        name: buildingName, address: 'Phnom Penh', remark: 'MariaDB tenant E2E'
      }, buildingRequestId);
      assert.equal(buildingCreated.status, 201, appId + ' building create');
      const buildingBody = await buildingCreated.json();
      assert.ok(Number.isSafeInteger(buildingBody.id), appId + ' building create ID');
      const buildingReplay = await writeBuilding(base, 'POST', '/api/buildings', {
        name: buildingName, address: 'Phnom Penh', remark: 'MariaDB tenant E2E'
      }, buildingRequestId);
      assert.equal(buildingReplay.status, 201, appId + ' building idempotent replay');
      assert.equal((await buildingReplay.json()).id, buildingBody.id, appId + ' building replay ID');
      const buildingUpdated = await writeBuilding(base, 'PATCH', '/api/buildings/' + buildingBody.id, {
        address: 'Phnom Penh, Cambodia'
      }, 'ci-building-patch-' + appId + '-0001');
      assert.equal(buildingUpdated.status, 200, appId + ' building patch');
      const [[buildingRows]] = await pool.query('SELECT name, address, remark FROM buildings WHERE id = ?', [buildingBody.id]);
      assert.deepEqual(buildingRows, {
        name: buildingName, address: 'Phnom Penh, Cambodia', remark: 'MariaDB tenant E2E'
      }, appId + ' persisted building state');
      const duplicateBuilding = await writeBuilding(base, 'POST', '/api/buildings', {
        name: buildingName
      }, 'ci-building-duplicate-' + appId);
      assert.equal(duplicateBuilding.status, 409, appId + ' duplicate building name');
      const tenantPayload = appId === 'property'
        ? { name: 'CI Company ' + appId, contact: 'CI Admin', phone: '123456', license_no: 'CI-LIC-' + appId }
        : { name: 'CI Person ' + appId, gender: '女', phone: '123456', id_card: 'CI-ID-' + appId };
      const tenantCreated = await writeBuilding(base, 'POST', '/api/tenants', tenantPayload, 'ci-tenant-create-' + appId + '-0001');
      assert.equal(tenantCreated.status, 201, appId + ' tenant/company create');
      const tenantBody = await tenantCreated.json();
      assert.ok(Number.isSafeInteger(tenantBody.id), appId + ' tenant/company ID');
      const tenantUpdated = await writeBuilding(base, 'PATCH', '/api/tenants/' + tenantBody.id, {
        phone: '987654'
      }, 'ci-tenant-patch-' + appId + '-0001');
      assert.equal(tenantUpdated.status, 200, appId + ' tenant/company patch');
      const [[tenantRows]] = await pool.query('SELECT phone FROM tenants WHERE id = ?', [tenantBody.id]);
      assert.equal(tenantRows.phone, '987654', appId + ' tenant/company persisted');

      if (appId === 'hotel') {
        const hotelRoom = { building_id: buildingBody.id, room_no: 'CI-H-ORDER-ROOM', day_price: 80, deposit: 30, status: 'vacant' };
        const availableRoomResponse = await post(base, hotelRoom, 'ci-hotel-order-room-0001');
        assert.equal(availableRoomResponse.status, 201, 'hotel order room create');
        const availableRoom = await availableRoomResponse.json();
        const orderPayload = { order_no: 'CI-H-ORDER-0001', room_id: availableRoom.id, guest_id: tenantBody.id,
          check_in_date: '2030-01-02', check_out_date: '2030-01-05' };
        const orderCreated = await hotelOrderRequest(base, 'POST', '/api/orders', orderPayload, 'ci-hotel-order-create-0001');
        assert.equal(orderCreated.status, 201, 'hotel order create');
        const order = await orderCreated.json();
        assert.equal(order.days, 3, 'hotel order day count');
        assert.equal(Number(order.total), 240, 'hotel order uses database room price');
        assert.equal(Number(order.deposit), 30, 'hotel order uses database room deposit');
        const [[bookedRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [availableRoom.id]);
        assert.equal(bookedRoom.status, 'booked', 'hotel order reserves room');
        const orderCheckin = await hotelOrderRequest(base, 'PATCH', '/api/orders/' + order.id + '/status', { status: 'checked_in' }, 'ci-hotel-order-checkin-0001');
        assert.equal(orderCheckin.status, 200, 'hotel order check-in');
        const [[occupiedRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [availableRoom.id]);
        assert.equal(occupiedRoom.status, 'rented', 'hotel check-in occupies room');
        const orderCheckout = await hotelOrderRequest(base, 'PATCH', '/api/orders/' + order.id + '/status', { status: 'checked_out' }, 'ci-hotel-order-checkout-0001');
        assert.equal(orderCheckout.status, 200, 'hotel order check-out');
        const [[cleaningRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [availableRoom.id]);
        assert.equal(cleaningRoom.status, 'cleaning', 'hotel check-out sends room to cleaning');
        const [[checkoutBill]] = await pool.query('SELECT source, room_id, tenant_id, order_id, amount, paid_amount, status FROM bills WHERE order_id = ?', [order.id]);
        assert.deepEqual(checkoutBill, { source: 'hotel', room_id: availableRoom.id, tenant_id: tenantBody.id, order_id: order.id, amount: '240.00', paid_amount: '0.00', status: 'unpaid' }, 'hotel checkout creates receivable exactly once');

        const invalidReentry = await hotelOrderRequest(base, 'PATCH', '/api/orders/' + order.id + '/status', { status: 'checked_in' }, 'ci-hotel-order-reentry-0001');
        assert.equal(invalidReentry.status, 409, 'hotel order cannot re-enter after checkout');
      }




      const [[billSeed]] = await pool.execute("INSERT INTO bills (source, room_id, period_start, period_end, due_date, amount, paid_amount, status) VALUES (?, ?, '2030-01-01', '2030-01-31', '2030-01-31', 100, 0, 'unpaid')", [appId === 'hotel' ? 'hotel' : appId === 'property' ? 'property' : 'rental', firstBody.id]);
      const partialPayment = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', { amount: 35, pay_method: 'bank', pay_date: '2030-01-31' }, 'ci-bill-partial-' + appId);
      assert.equal(partialPayment.status, 200, appId + ' partial bill payment');
      const partialBody = await partialPayment.json();
      assert.equal(Number(partialBody.paid_amount), 35, appId + ' partial paid amount');
      assert.equal(partialBody.status, 'partial', appId + ' partial bill status');
      const finalPayment = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', { amount: 65, pay_method: 'bank', pay_date: '2030-02-01' }, 'ci-bill-final-' + appId);
      assert.equal(finalPayment.status, 200, appId + ' final bill payment');
      const [[paidBill]] = await pool.query('SELECT paid_amount, status FROM bills WHERE id = ?', [billSeed.insertId]);
      assert.equal(Number(paidBill.paid_amount), 100, appId + ' fully paid amount');
      assert.equal(paidBill.status, 'paid', appId + ' fully paid status');
      const overpayment = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', { amount: 1 }, 'ci-bill-overpay-' + appId);
      assert.equal(overpayment.status, 409, appId + ' overpayment rejected');

      const room = { ...definition.room };
      const requestId = 'ci-room-create-' + appId + '-000001';

      const [first, replay] = await Promise.all([
        post(base, room, requestId),
        post(base, room, requestId)
      ]);
      assert.equal(first.status, 201, appId + ' first create');
      assert.equal(replay.status, 201, appId + ' idempotent replay');
      const firstBody = await first.json();
      if (appId === 'rental' || appId === 'property') {
        const meterPayload = { room_id: firstBody.id, month: '2030-01', water_prev: 10, water_curr: 12.5, elec_prev: 20, elec_curr: 23 };
        const meterCreated = await hotelOrderRequest(base, 'POST', '/api/meters', meterPayload, 'ci-meter-create-' + appId + '-0001');
        assert.equal(meterCreated.status, 201, appId + ' meter create');
        const meter = await meterCreated.json();
        assert.equal(Number(meter.water_usage), 2.5, appId + ' water usage');
        assert.equal(Number(meter.water_fee), 5, appId + ' water fee from room rate');
        assert.equal(Number(meter.elec_usage), 3, appId + ' electricity usage');
        assert.equal(Number(meter.elec_fee), 4.5, appId + ' electricity fee from room rate');
        const [[meterRows]] = await pool.query('SELECT water_fee, elec_fee FROM meters WHERE id = ?', [meter.id]);
        assert.equal(Number(meterRows.water_fee), 5, appId + ' persisted water fee');
        const duplicateMeter = await hotelOrderRequest(base, 'POST', '/api/meters', meterPayload, 'ci-meter-duplicate-' + appId + '-0001');
        assert.equal(duplicateMeter.status, 409, appId + ' duplicate room-month meter rejected');
        const invalidBaseline = await hotelOrderRequest(base, 'POST', '/api/meters', { ...meterPayload, month: '2030-02', water_prev: 11 }, 'ci-meter-baseline-' + appId + '-0001');
        assert.equal(invalidBaseline.status, 409, appId + ' next period baseline must match previous reading');
      }

      const replayBody = await replay.json();
      assert.equal(firstBody.id, replayBody.id, appId + ' replay ID');
      const [[countRows]] = await pool.query('SELECT COUNT(*) AS total FROM rooms WHERE room_no = ?', [room.room_no]);
      assert.equal(Number(countRows.total), 1, appId + ' concurrent duplicate mutation');
      const [auditEvents] = await pool.query('SELECT event, COUNT(*) AS total FROM tenant_write_audit WHERE request_id = ? GROUP BY event', [requestId]);
      const eventCounts = Object.fromEntries(auditEvents.map(row => [row.event, Number(row.total)]));
      assert.deepEqual(eventCounts, { tenant_write_started: 2, tenant_write_committed: 1, tenant_write_replayed: 1 }, appId + ' transactional audit events');

      const repairCreated = await writeBuilding(base, 'POST', '/api/repairs', {
        room_id: firstBody.id, title: 'CI repair ' + appId, content: 'Integration repair'
      }, 'ci-repair-create-' + appId + '-0001');
      assert.equal(repairCreated.status, 201, appId + ' repair create');
      const repairBody = await repairCreated.json();
      assert.equal(repairBody.status, 'pending', appId + ' repair initial status');
      const skipRepairState = await writeBuilding(base, 'PATCH', '/api/repairs/' + repairBody.id, {
        status: 'done'
      }, 'ci-repair-skip-' + appId + '-0001');
      assert.equal(skipRepairState.status, 409, appId + ' repair cannot skip processing');
      const repairProcessing = await writeBuilding(base, 'PATCH', '/api/repairs/' + repairBody.id, {
        status: 'processing', handler: 'CI technician'
      }, 'ci-repair-processing-' + appId + '-0001');
      assert.equal(repairProcessing.status, 200, appId + ' repair processing');
      const repairDone = await writeBuilding(base, 'PATCH', '/api/repairs/' + repairBody.id, {
        status: 'done', handle_note: 'Verified by CI'
      }, 'ci-repair-done-' + appId + '-0001');
      assert.equal(repairDone.status, 200, appId + ' repair completion');
      const [[repairRows]] = await pool.query('SELECT status, handler, handle_note FROM repairs WHERE id = ?', [repairBody.id]);
      assert.deepEqual(repairRows, { status: 'done', handler: 'CI technician', handle_note: 'Verified by CI' }, appId + ' repair persisted');
      denyAuthorization = true;
      const forbidden = await post(base, { ...room, room_no: 'CI-DENY-' + appId }, 'ci-write-denied-' + appId);
      assert.equal(forbidden.status, 403, appId + ' authorization denied');
      denyAuthorization = false;
      denyStepUp = true;
      const stepUpDenied = await post(base, { ...room, room_no: 'CI-STEP-' + appId }, 'ci-stepup-denied-' + appId);
      assert.equal(stepUpDenied.status, 403, appId + ' step-up denied');
      denyStepUp = false;

      const changed = { ...room, room_no: room.room_no + '-changed' };
      const conflict = await post(base, changed, requestId);
      assert.equal(conflict.status, 409, appId + ' idempotency payload conflict');

      const duplicate = await post(base, room, 'ci-room-duplicate-' + appId + '-0001');
      assert.equal(duplicate.status, 409, appId + ' duplicate room key');

      const missingBuilding = await post(base, { ...room, building_id: 999999 }, 'ci-room-missing-building-' + appId);
      assert.equal(missingBuilding.status, 404, appId + ' missing building');

      failCommitAudit = true;
      const auditFailureRoom = { ...room, room_no: 'CI-AUD-' + appId.toUpperCase() };
      const auditFailure = await post(base, auditFailureRoom, 'ci-room-audit-failure-' + appId);
      assert.equal(auditFailure.status, 500, appId + ' audit failure status');
      failCommitAudit = false;
      const [[rolledBackRows]] = await pool.query('SELECT COUNT(*) AS total FROM rooms WHERE room_no = ?', [auditFailureRoom.room_no]);
      assert.equal(Number(rolledBackRows.total), 0, appId + ' audit failure rollback');
      const [[idemRows]] = await pool.query('SELECT COUNT(*) AS total FROM tenant_write_idempotency WHERE request_id = ?', ['ci-room-audit-failure-' + appId]);
      assert.equal(Number(idemRows.total), 0, appId + ' audit failure idempotency rollback');

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
      try { await adminPool.query('DROP USER IF EXISTS ' + mysql.escape(user) + '@' + mysql.escape('%')); } catch (_) {}
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
