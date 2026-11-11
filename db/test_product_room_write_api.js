'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

function harness(appId, { ownerExists = true, buildingExists = true, roomExists = false, writeEnabled = true } = {}) {
  const statements = [];
  const txEvents = [];
  let registryTenantId;
  const connection = {
    async beginTransaction() { txEvents.push('begin'); },
    async commit() { txEvents.push('commit'); },
    async rollback() { txEvents.push('rollback'); },
    release() { txEvents.push('release'); },
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('FROM buildings')) return [buildingExists ? [{ id: 7 }] : [], []];
      if (sql.includes('FROM rooms')) return [roomExists ? [{ id: 80 }] : [], []];
      if (sql.includes('FROM tenants')) return [ownerExists ? [{ id: 9 }] : [], []];
      if (sql.startsWith('INSERT INTO')) return [{ insertId: 81, affectedRows: 1 }, []];
      throw new Error('UNEXPECTED_SQL');
    }
  };
  const pool = { async getConnection() { return connection; }, async execute() { throw new Error('POOL_QUERY_NOT_ALLOWED'); } };
  const dependencies = {
    authenticate(req, _res, next) {
      req.auth = { authenticated: true, appId, tenantId: TENANT_ID, userId: 'user-1', sessionId: 'session-1' };
      next();
    },
    registry: {
      async findTenantById(id) {
        registryTenantId = id;
        return { tenant_uuid: TENANT_ID, app_id: appId, lifecycle_state: 'active',
          db_host: 'db.internal', db_port: 3306, db_name: 'tenant_db', db_secret_ref: 'secret-ref', schema_version: '1' };
      }
    },
    secretProvider: { async getDatabaseCredentials() { return { user: 'tenant_user', password: 'secret', version: '1' }; } },
    poolManager: { async getPool() { return pool; } }
  };
  if (writeEnabled) {
    dependencies.writeService = {
      async execute(input) {
        return input.repository.withTransaction(tx => input.mutate(tx, input.payload));
      }
    };
  }
  const app = appId === 'hotel' ? createHotelApi(dependencies) : createPropertyApi(dependencies);
  return { app, statements, txEvents, get registryTenantId() { return registryTenantId; } };
}

async function post(app, body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operation-reason': 'Approved room creation',
        'x-step-up-token': 'step-up-token-123456789', 'idempotency-key': 'room-create-request-0001',
        'x-tenant-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      body: JSON.stringify(body)
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('hotel API mounts tenant-scoped room writes and persists hotel-only fields', async () => {
  const h = harness('hotel');
  const response = await post(h.app, { building_id: 7, room_no: 'H-101', day_price: 60, deposit: 20, status: 'booked' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).id, 81);
  assert.equal(h.registryTenantId, TENANT_ID);
  const insert = h.statements.find(item => item.sql.startsWith('INSERT INTO'));
  assert.match(insert.sql, /day_price/);
  assert.doesNotMatch(insert.sql, /rent/);
  assert.deepEqual(h.txEvents, ['begin', 'commit', 'release']);
});

test('property API checks owner existence before insert and rolls back on missing owner', async () => {
  const h = harness('property', { ownerExists: false });
  const response = await post(h.app, { building_id: 7, room_no: 'P-201', owner_id: 9, property_fee: 100 });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'ROOM_OWNER_NOT_FOUND' });
  assert.equal(h.statements.some(item => item.sql.startsWith('INSERT INTO')), false);
  assert.deepEqual(h.txEvents, ['begin', 'rollback', 'release']);
});

test('property API persists owner and property-specific fields when owner exists', async () => {
  const h = harness('property');
  const response = await post(h.app, { building_id: 7, room_no: 'P-202', owner_id: 9, property_fee: 100, water_price: 2, elec_price: 1.5 });
  assert.equal(response.status, 201);
  const insert = h.statements.find(item => item.sql.startsWith('INSERT INTO'));
  assert.match(insert.sql, /owner_id/);
  assert.match(insert.sql, /property_fee/);
  assert.doesNotMatch(insert.sql, /day_price|rent/);
});

test('product API fails closed when the tenant write service is not configured', async () => {
  const h = harness('hotel', { writeEnabled: false });
  const response = await post(h.app, { building_id: 7, room_no: 'H-102' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TENANT_WRITE_UNAVAILABLE' });
  assert.deepEqual(h.txEvents, []);
});

test('room write rejects a missing building and duplicate room without committing', async () => {
  const missingBuilding = harness('hotel', { buildingExists: false });
  const missing = await post(missingBuilding.app, { building_id: 7, room_no: 'H-404' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'BUILDING_NOT_FOUND' });
  assert.deepEqual(missingBuilding.txEvents, ['begin', 'rollback', 'release']);

  const duplicateRoom = harness('hotel', { roomExists: true });
  const duplicate = await post(duplicateRoom.app, { building_id: 7, room_no: 'H-101' });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'ROOM_ALREADY_EXISTS' });
  assert.deepEqual(duplicateRoom.txEvents, ['begin', 'rollback', 'release']);
});
