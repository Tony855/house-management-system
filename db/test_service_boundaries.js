'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createRentalApi } = require('../services/rental-api/app');
const { createHotelApi } = require('../services/hotel-api/app');
const { createPropertyApi } = require('../services/property-api/app');
const { createPlatformApi } = require('../services/platform-api/app');

async function health(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/health/live');
    return { status: response.status, body: await response.json() };
  } finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
const productDeps = {
  authenticate: (_req, _res, next) => next(),
  registry: { findTenantById: async () => null },
  secretProvider: { getDatabaseCredentials: async () => null },
  poolManager: { getPool: async () => ({}) }
};
test('each product API factory is fixed to its own audience and health identity', async () => {
  for (const [factory, id] of [[createRentalApi,'rental'],[createHotelApi,'hotel'],[createPropertyApi,'property']]) {
    const result = await health(factory(productDeps));
    assert.equal(result.status, 200);
    assert.equal(result.body.service, id + '-api');
  }
});
test('product API cannot be reconfigured to another product through dependencies', () => {
  assert.throws(() => createRentalApi({ ...productDeps, appId: 'hotel' }), /APP_ID_INVALID|PRODUCT_API_ID_INVALID/);
});
test('platform API uses a separate injected platform pool and health identity', async () => {
  const pool = { query: async () => [[]], getConnection: async () => ({}) };
  const result = await health(createPlatformApi({ pool, authenticate: (_req,_res,next) => next() }));
  assert.equal(result.status, 200);
  assert.equal(result.body.service, 'platform-api');
  assert.throws(() => createPlatformApi({ pool: null, authenticate: () => {} }), /PLATFORM_DB_POOL_REQUIRED/);
});
