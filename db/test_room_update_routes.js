'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createRoomUpdateRouter } = require('../services/shared/room-update-routes');

const existing = {
  id: 7, building_id: 1, room_no: 'A-101', floor: 1, area: 30,
  rent: 1000, deposit: 1000, status: 'vacant', room_type: '',
  is_dorm: 0, capacity: 0, water_price: 0, elec_price: 0, remark: ''
};
async function send(appId, body, options = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = async input => {
      calls.push(input);
      return input.mutate({
        execute: async (sql, params) => {
          if (sql.startsWith('SELECT * FROM rooms')) return [[{ ...existing, ...(options.row || {}) }]];
          if (sql.includes('FROM buildings')) return [[{ id: 1 }]];
          if (sql.includes('FROM tenants')) return [[{ id: 8 }]];
          if (sql.includes('id <>')) return [[]];
          throw new Error('UNEXPECTED_SQL ' + sql);
        },
        updateById: async (table, id, fields) => { calls.push({ table, id, fields }); return { affectedRows: 1 }; }
      });
    };
    next();
  });
  app.use('/api', createRoomUpdateRouter(appId));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms/7', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-operation-reason': 'Update room details', 'idempotency-key': 'room-update-request-001' }, body: JSON.stringify(body)
    });
    return { response, calls };
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('rental, hotel and property room updates are tenant-write audited and use product-specific DTOs', async () => {
  const cases = [
    ['rental', { rent: 1200 }, { rent: 1200 }],
    ['hotel', { day_price: 80 }, { day_price: 80 }],
    ['property', { property_fee: 150 }, { property_fee: 150 }]
  ];
  for (const [appId, patch, expected] of cases) {
    const { response, calls } = await send(appId, patch, { row: appId === 'hotel' ? { day_price: 50 } : appId === 'property' ? { rent: undefined, owner_id: null, property_fee: 100 } : {} });
    assert.equal(response.status, 200, appId);
    assert.equal(calls[0].operation, 'update');
    assert.deepEqual(calls.at(-1).fields && Object.fromEntries(Object.entries(calls.at(-1).fields).filter(([key]) => Object.hasOwn(expected, key))), expected);
  }
});
test('room update rejects unknown tenant-controlled columns before write', async () => {
  const { response, calls } = await send('rental', { org_id: 999 });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
test('room update does not write when room is missing', async () => {
  const { response } = await send('rental', { rent: 1200 }, { row: null });
  assert.equal(response.status, 404);
});
