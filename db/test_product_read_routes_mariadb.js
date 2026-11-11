'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const mysql = require('mysql2/promise');
const { TenantPoolManager } = require('../server/tenant-db');
const { createRentalApi } = require('../services/rental-api/app');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const dbNames = {
  rental: 'house_sys_rental',
  hotel: 'house_sys_hotel',
  property: 'house_sys_property'
};
const resources = {
  rental: ['buildings', 'rooms', 'tenants', 'contracts', 'meters', 'network-lines', 'network-changes', 'network-requests', 'bills', 'repairs'],
  hotel: ['buildings', 'rooms', 'tenants', 'orders', 'bills', 'repairs'],
  property: ['buildings', 'rooms', 'tenants', 'employees', 'meters', 'network-lines', 'network-changes', 'network-requests', 'bills', 'repairs', 'complaints']
};

async function serve(app, path) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path);
    const body = await response.json();
    assert.equal(response.status, 200, path + ': ' + JSON.stringify(body));
    assert.ok(Array.isArray(body.items));
    assert.equal(typeof body.total, 'number');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function main() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const factories = { rental: createRentalApi, hotel: createHotelApi, property: createPropertyApi };
  for (const [appId, factory] of Object.entries(factories)) {
    const poolManager = new TenantPoolManager({ createPool: config => mysql.createPool(config), maxPools: 4 });
    const tenant = {
      tenant_uuid: tenantId, app_id: appId, lifecycle_state: 'active',
      db_host: host, db_port: port, db_name: dbNames[appId],
      db_secret_ref: 'ci/' + appId, schema_version: 'ci'
    };
    const app = factory({
      authenticate: (req, _res, next) => {
        req.auth = { authenticated: true, appId, tenantId };
        next();
      },
      registry: { findTenantById: async id => id === tenantId ? tenant : null },
      secretProvider: { getDatabaseCredentials: async () => ({ user, password, version: 'ci' }) },
      poolManager
    });
    try {
      for (const resource of resources[appId]) {
        await serve(app, '/api/' + resource + '?limit=5');
      }
    } finally {
      await poolManager.closeAll();
    }
  }
  process.stdout.write('Product tenant read routes passed against all three MariaDB schemas.\n');
}

main().catch(error => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
