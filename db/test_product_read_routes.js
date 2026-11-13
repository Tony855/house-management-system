'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant = {
  tenant_uuid: tenantId, app_id: 'rental', lifecycle_state: 'active',
  db_host: '127.0.0.1', db_port: 3306, db_name: 'tenant_rental_a',
  db_secret_ref: 'tenant/rental/a', schema_version: 'v1'
};
const { createRentalApi } = require('../services/rental-api/app');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');

async function request(app, path) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function dependencies(appId, calls) {
  const mappedTenant = { ...tenant, app_id: appId };
  return {
    authenticate: (req, _res, next) => {
      req.auth = { authenticated: true, appId, tenantId };
      next();
    },
    registry: { findTenantById: async id => id === tenantId ? mappedTenant : null },
    secretProvider: { getDatabaseCredentials: async () => ({ user: 'tenant_user', password: 'not-a-real-secret' }) },
    poolManager: { getPool: async context => ({
      async execute(sql, params) {
        calls.push({ database: context.db.database, sql, params });
        if (sql.startsWith('SELECT COUNT')) return [[{ total: 3 }], []];
        return [[{ id: 1, name: 'safe-record' }], []];
      }
    }) }
  };
}

test('rental, hotel and property APIs expose only their own read resource routes', async () => {
  const cases = [
    [createRentalApi, 'rental', '/api/contracts'],
    [createHotelApi, 'hotel', '/api/orders'],
    [createPropertyApi, 'property', '/api/complaints']
  ];
  for (const [factory, appId, path] of cases) {
    const calls = [];
    const result = await request(factory(dependencies(appId, calls)), path + '?limit=10');
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 3);
    assert.equal(result.body.limit, 10);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.database === 'tenant_rental_a'));
  }
});

test('product read routes reject invalid pagination and unreviewed sort columns', async () => {
  const calls = [];
  const app = createRentalApi(dependencies('rental', calls));
  assert.equal((await request(app, '/api/rooms?limit=101')).status, 400);
  assert.equal((await request(app, '/api/rooms?sort=password')).status, 400);
  assert.equal(calls.length, 0);
});

test('public tenant and employee projections do not select identity document or photo fields', async () => {
  const calls = [];
  const app = createPropertyApi(dependencies('property', calls));
  assert.equal((await request(app, '/api/tenants')).status, 200);
  assert.equal((await request(app, '/api/employees')).status, 200);
  const sql = calls.map(call => call.sql).join('\n');
  for (const sensitive of ['id_card', 'license_no', 'id_number', 'card_no', 'photo_url', 'id_photo_url']) {
    assert.equal(sql.includes('`' + sensitive + '`'), false, sensitive + ' must not be selected');
  }
});
