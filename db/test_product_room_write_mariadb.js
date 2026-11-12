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
  await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'migrations/tenant/004_bill_transactions.sql'), 'utf8'));
  await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'migrations/tenant/005_property_collection_actions.sql'), 'utf8'));
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
        const cleaningComplete = await hotelOrderRequest(base, 'POST', '/api/rooms/' + availableRoom.id + '/cleaning-complete', {}, 'ci-hotel-cleaning-complete-0001');
        assert.equal(cleaningComplete.status, 200, 'hotel cleaning completion');
        const [[cleanedRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [availableRoom.id]);
        assert.equal(cleanedRoom.status, 'vacant', 'cleaning completion releases room');

        const [[checkoutBill]] = await pool.query('SELECT source, room_id, tenant_id, order_id, amount, paid_amount, status FROM bills WHERE order_id = ?', [order.id]);
        assert.deepEqual(checkoutBill, { source: 'hotel', room_id: availableRoom.id, tenant_id: tenantBody.id, order_id: order.id, amount: '240.00', paid_amount: '0.00', status: 'unpaid' }, 'hotel checkout creates receivable exactly once');

        const cancelRoomResponse = await post(base, { building_id: buildingBody.id, room_no: 'CI-H-CANCEL-ROOM', day_price: 40, deposit: 15, status: 'vacant' }, 'ci-hotel-cancel-room-0001');
        assert.equal(cancelRoomResponse.status, 201, 'hotel cancellation room create');
        const cancelRoom = await cancelRoomResponse.json();
        const cancelOrderResponse = await hotelOrderRequest(base, 'POST', '/api/orders', {
          order_no: 'CI-H-CANCEL-0001', room_id: cancelRoom.id, guest_id: tenantBody.id,
          check_in_date: '2031-01-02', check_out_date: '2031-01-04'
        }, 'ci-hotel-cancel-order-0001');
        assert.equal(cancelOrderResponse.status, 201, 'hotel cancellation order create');
        const cancelOrder = await cancelOrderResponse.json();
        const cancelResponse = await hotelOrderRequest(base, 'PATCH', '/api/orders/' + cancelOrder.id + '/status', { status: 'cancelled' }, 'ci-hotel-cancel-order-status-0001');
        assert.equal(cancelResponse.status, 200, 'hotel booking cancellation');
        const [[cancelledOrder]] = await pool.query('SELECT status FROM orders WHERE id = ?', [cancelOrder.id]);
        const [[cancelledRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [cancelRoom.id]);
        assert.equal(cancelledOrder.status, 'cancelled', 'hotel cancellation persisted');
        assert.equal(cancelledRoom.status, 'vacant', 'hotel cancellation releases room');
        const invalidReentry = await hotelOrderRequest(base, 'PATCH', '/api/orders/' + order.id + '/status', { status: 'checked_in' }, 'ci-hotel-order-reentry-0001');
        assert.equal(invalidReentry.status, 409, 'hotel order cannot re-enter after checkout');
      }





      const room = { ...definition.room };
      const requestId = 'ci-room-create-' + appId + '-000001';

      const [first, replay] = await Promise.all([
        post(base, room, requestId),
        post(base, room, requestId)
      ]);
      assert.equal(first.status, 201, appId + ' first create');
      assert.equal(replay.status, 201, appId + ' idempotent replay');
      const firstBody = await first.json();
      if (appId === 'rental') {
        const contractResponse = await writeBuilding(base, 'POST', '/api/contracts', {
          contract_no: 'CI-RENTAL-BILL-0001', room_id: firstBody.id, tenant_id: tenantBody.id,
          start_date: '2020-01-01', end_date: '2040-12-31', sign_date: '2020-01-01',
          rent: 120, deposit: 0, pay_cycle: 1
        }, 'ci-rental-contract-create-0001');
        assert.equal(contractResponse.status, 201, 'rental contract create for billing integration');
        const contract = await contractResponse.json();
        const [generatedFirst, generatedReplay] = await Promise.all([
          writeBuilding(base, 'POST', '/api/contracts/' + contract.id + '/generate-bill', {}, 'ci-rental-bill-generate-0001'),
          writeBuilding(base, 'POST', '/api/contracts/' + contract.id + '/generate-bill', {}, 'ci-rental-bill-generate-0001')
        ]);
        assert.equal(generatedFirst.status, 201, 'rental first contract bill');
        assert.equal(generatedReplay.status, 201, 'rental contract bill idempotent replay');
        const firstBill = await generatedFirst.json();
        const replayBill = await generatedReplay.json();
        assert.equal(firstBill.id, replayBill.id, 'rental generated bill replay ID');
        assert.equal(firstBill.period_start, '2020-01-01', 'rental first billing period start');
        assert.equal(Number(firstBill.amount), 120, 'rental contract bill amount');
        const [[firstBillCount]] = await pool.query('SELECT COUNT(*) AS total FROM bills WHERE contract_id = ? AND source = ?', [contract.id, 'rental']);
        assert.equal(Number(firstBillCount.total), 1, 'concurrent idempotent generation creates one rental bill');
        const nextBillResponse = await writeBuilding(base, 'POST', '/api/contracts/' + contract.id + '/generate-bill', {}, 'ci-rental-bill-generate-0002');
        assert.equal(nextBillResponse.status, 201, 'rental next contract billing period');
        const nextBill = await nextBillResponse.json();
        assert.equal(nextBill.period_start, '2020-02-01', 'rental next period follows last bill');
        const renewalResponse = await writeBuilding(base, 'POST', '/api/contracts/' + contract.id + '/renew', {
          end_date: '2041-12-31', rent: 130, deposit: 25, pay_cycle: 1
        }, 'ci-rental-contract-renew-0001');
        assert.equal(renewalResponse.status, 200, 'rental contract renewal');
        const renewed = await renewalResponse.json();
        assert.equal(renewed.previous_end_date, '2040-12-31', 'rental renewal previous end date');
        const [[renewedContract]] = await pool.query('SELECT end_date, rent, deposit, pay_cycle, status FROM contracts WHERE id = ?', [contract.id]);
        assert.deepEqual(renewedContract, { end_date: new Date('2041-12-31T00:00:00.000Z'), rent: '130.00', deposit: '25.00', pay_cycle: 1, status: 'active' }, 'rental renewal terms persisted');
        const terminationRoomResponse = await post(base, { building_id: buildingBody.id, room_no: 'CI-R-TERM-101', rent: 80, deposit: 25 }, 'ci-rental-term-room-0001');
        assert.equal(terminationRoomResponse.status, 201, 'rental termination test room');
        const terminationRoom = await terminationRoomResponse.json();
        const terminationContractResponse = await writeBuilding(base, 'POST', '/api/contracts', {
          contract_no: 'CI-RENTAL-TERM-0001', room_id: terminationRoom.id, tenant_id: tenantBody.id,
          start_date: '2020-01-01', end_date: '2040-12-31', sign_date: '2020-01-01',
          rent: 80, deposit: 25, pay_cycle: 1
        }, 'ci-rental-term-contract-0001');
        assert.equal(terminationContractResponse.status, 201, 'rental termination contract create');
        const terminationContract = await terminationContractResponse.json();
        const terminatedResponse = await writeBuilding(base, 'POST', '/api/contracts/' + terminationContract.id + '/terminate', {
          termination_date: new Date().toISOString().slice(0, 10)
        }, 'ci-rental-contract-terminate-0001');
        assert.equal(terminatedResponse.status, 200, 'rental contract termination');
        const terminatedBody = await terminatedResponse.json();
        assert.equal(terminatedBody.status, 'terminated', 'rental contract terminated');
        assert.equal(terminatedBody.deposit_settlement.status, 'pending', 'deposit is not falsely marked refunded');
        const [[terminatedState]] = await pool.query('SELECT status, end_date FROM contracts WHERE id = ?', [terminationContract.id]);
        assert.equal(terminatedState.status, 'terminated', 'rental termination persisted');
        const [[releasedRoom]] = await pool.query('SELECT status FROM rooms WHERE id = ?', [terminationRoom.id]);
        assert.equal(releasedRoom.status, 'vacant', 'rental termination releases room');
        const [[allContractBills]] = await pool.query('SELECT COUNT(*) AS total FROM bills WHERE contract_id = ? AND source = ?', [contract.id, 'rental']);
        assert.equal(Number(allContractBills.total), 2, 'rental sequential generation creates next period only');
      }

      const [billSeed] = await pool.execute("INSERT INTO bills (source, room_id, period_start, period_end, due_date, amount, paid_amount, status) VALUES (?, ?, '2030-03-01', '2030-03-31', '2030-03-31', 100, 0, 'unpaid')", [appId === 'hotel' ? 'hotel' : appId === 'property' ? 'property' : 'rental', firstBody.id]);
      const partialRequestId = 'ci-bill-partial-' + appId;
      const partialPayload = { amount: 35, pay_method: 'bank', pay_date: '2030-01-31' };
      const [partialPayment, partialReplay] = await Promise.all([
        hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', partialPayload, partialRequestId),
        hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', partialPayload, partialRequestId)
      ]);
      assert.equal(partialPayment.status, 200, appId + ' partial bill payment');
      assert.equal(partialReplay.status, 200, appId + ' idempotent partial payment replay');
      const partialBody = await partialPayment.json();
      const partialReplayBody = await partialReplay.json();
      assert.equal(Number(partialBody.paid_amount), 35, appId + ' partial paid amount');
      assert.equal(Number(partialReplayBody.paid_amount), 35, appId + ' replay does not double-charge');
      assert.equal(partialBody.status, 'partial', appId + ' partial bill status');
      const finalPayment = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', { amount: 65, pay_method: 'bank', pay_date: '2030-02-01' }, 'ci-bill-final-' + appId);
      assert.equal(finalPayment.status, 200, appId + ' final bill payment');
      const [[ledgerRows]] = await pool.query('SELECT COUNT(*) AS total, SUM(amount) AS gross FROM bill_transactions WHERE bill_id = ?', [billSeed.insertId]);
      assert.equal(Number(ledgerRows.total), 2, appId + ' receipt ledger records payment and final settlement once each');
      assert.equal(Number(ledgerRows.gross), 100, appId + ' gross receipt ledger total');
      const [[paidBill]] = await pool.query('SELECT paid_amount, status FROM bills WHERE id = ?', [billSeed.insertId]);
      assert.equal(Number(paidBill.paid_amount), 100, appId + ' fully paid amount');
      assert.equal(paidBill.status, 'paid', appId + ' fully paid status');
      const refundPayload = { amount: 20, pay_method: 'bank', pay_date: '2030-02-02', external_reference: 'CI-REFUND-' + appId };
      const refundRequestId = 'ci-bill-refund-' + appId;
      const [refund, refundReplay] = await Promise.all([
        hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/refund', refundPayload, refundRequestId),
        hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/refund', refundPayload, refundRequestId)
      ]);
      assert.equal(refund.status, 200, appId + ' bill refund');
      assert.equal(refundReplay.status, 200, appId + ' idempotent refund replay');
      const refundBody = await refund.json();
      const refundReplayBody = await refundReplay.json();
      assert.equal(Number(refundReplayBody.paid_amount), 80, appId + ' refund replay does not refund twice');
      assert.equal(Number(refundBody.paid_amount), 80, appId + ' refund reduces paid balance');
      assert.equal(refundBody.status, 'partial', appId + ' refunded bill becomes partial');
      const [[refundLedger]] = await pool.query("SELECT transaction_type, amount, external_reference FROM bill_transactions WHERE bill_id = ? AND transaction_type = 'refund'", [billSeed.insertId]);
      assert.deepEqual(refundLedger, { transaction_type: 'refund', amount: '20.00', external_reference: 'CI-REFUND-' + appId }, appId + ' refund audit ledger');
      const reconciliationResponse = await fetch(base + '/api/finance/reconciliation?from_date=2030-01-01&to_date=2030-12-31');
      assert.equal(reconciliationResponse.status, 200, appId + ' finance reconciliation endpoint');
      const reconciliation = await reconciliationResponse.json();
      const billSource = appId === 'hotel' ? 'hotel' : appId === 'property' ? 'property' : 'rental';
      const reconciledSource = reconciliation.items.find(item => item.source === billSource);
      assert.ok(reconciledSource, appId + ' reconciliation includes product source');
      assert.equal(reconciledSource.mismatch_count, 0, appId + ' bill ledger balances reconcile');
      assert.ok(reconciledSource.receipts >= 100, appId + ' reconciliation includes receipts');
      assert.ok(reconciledSource.refunds >= 20, appId + ' reconciliation includes refunds');
      const excessiveRefund = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/refund', { amount: 81 }, 'ci-bill-refund-excess-' + appId);
      assert.equal(excessiveRefund.status, 409, appId + ' refund cannot exceed net received amount');
      const overpayment = await hotelOrderRequest(base, 'POST', '/api/bills/' + billSeed.insertId + '/pay', { amount: 21 }, 'ci-bill-overpay-' + appId);
      assert.equal(overpayment.status, 409, appId + ' overpayment rejected');

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
        if (appId === 'property') {
          const generatedFees = await writeBuilding(base, 'POST', '/api/property-fees/generate', {
            month: '2030-01'
          }, 'ci-property-fees-generate-0001');
          assert.equal(generatedFees.status, 201, 'property monthly fee generation');
          const generatedBody = await generatedFees.json();
          const arrearsResponse = await fetch(base + '/api/property-fees/arrears?as_of=2030-02-01');
          assert.equal(arrearsResponse.status, 200, 'property arrears report');
          const arrears = await arrearsResponse.json();
          assert.ok(arrears.items.some(item => item.room_id === firstBody.id && Number(item.outstanding_amount) === 109.5),
            'property arrears includes generated monthly owner fee');
          assert.equal(arrears.page, 1, 'property arrears default page');
          assert.equal(arrears.page_size, 50, 'property arrears default page size');
          assert.equal(arrears.total_count, 1, 'property arrears complete count');
          assert.equal(Number(arrears.total_outstanding), 109.5, 'property arrears complete total');
          assert.equal(Number(arrears.aging.days_1_30), 109.5, 'property arrears aging bucket');
          const collectionAction = await writeBuilding(base, 'POST', '/api/property-fees/' + generatedBody.bills[0].id + '/collection-actions', {
            action_type: 'phone', outcome: 'promised', contacted_at: '2030-02-01', follow_up_date: '2030-02-08', note: 'CI owner promised payment'
          }, 'ci-property-collection-0001');
          assert.equal(collectionAction.status, 201, 'property collection action');
          const collectionBody = await collectionAction.json();
          assert.equal(collectionBody.bill_id, generatedBody.bills[0].id, 'collection action linked to property bill');
          const [[collectionRows]] = await pool.query('SELECT action_type, outcome, DATE_FORMAT(follow_up_date, '%Y-%m-%d') AS follow_up_date, note FROM property_collection_actions WHERE id = ?', [collectionBody.id]);
          assert.deepEqual(collectionRows, { action_type: 'phone', outcome: 'promised', follow_up_date: '2030-02-08', note: 'CI owner promised payment' }, 'collection action persisted');

          const arrearsPage = await fetch(base + '/api/property-fees/arrears?as_of=2030-02-01&page=1&page_size=1');
          assert.equal(arrearsPage.status, 200, 'property arrears pagination');
          const pageBody = await arrearsPage.json();
          assert.equal(pageBody.items.length, 1, 'property arrears bounded page');
          assert.equal(pageBody.total_count, 1, 'property arrears count independent of page');
          const invalidArrearsPage = await fetch(base + '/api/property-fees/arrears?page_size=101');
          assert.equal(invalidArrearsPage.status, 400, 'property arrears rejects oversized page');

          assert.equal(generatedBody.generated, 1, 'property monthly fee generated once');
          assert.equal(generatedBody.bills.length, 1, 'property monthly fee bill count');
          assert.equal(Number(generatedBody.bills[0].amount), 109.5, 'property fee plus meter charges');
          assert.equal(generatedBody.bills[0].tenant_id, Number(definition.room.owner_id), 'property fee billed to room owner');
          const [[propertyBill]] = await pool.query(
            "SELECT source, tenant_id, DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start, DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date, amount, status FROM bills WHERE source = 'property' AND room_id = ? AND period_start = '2030-01-01'",
            [firstBody.id]
          );
          assert.deepEqual(propertyBill, {
            source: 'property', tenant_id: Number(definition.room.owner_id), period_start: '2030-01-01',
            period_end: '2030-01-31', due_date: '2030-01-10', amount: '109.50', status: 'unpaid'
          }, 'property receivable persisted with legacy billing dates');
          const feeReplay = await writeBuilding(base, 'POST', '/api/property-fees/generate', {
            month: '2030-01'
          }, 'ci-property-fees-generate-0002');
          assert.equal(feeReplay.status, 201, 'property fee duplicate period safely skipped');
          assert.equal((await feeReplay.json()).generated, 0, 'property fee not duplicated with a new request key');
        }
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
