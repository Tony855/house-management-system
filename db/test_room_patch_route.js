'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createRoomUpdateRouter } = require('../services/shared/room-update-routes');

test('PATCH /rooms/:id shares the validated tenant transaction and audit/idempotency boundary', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = async input => {
      calls.push(input);
      return input.mutate({
        execute: async sql => {
          if (sql.startsWith('SELECT * FROM rooms')) return [[{ id: 7, building_id: 1, room_no: 'A-7', floor: 1, area: 20, rent: 100, deposit: 0, status: 'vacant', room_type: '', water_price: 0, elec_price: 0, remark: '' }]];
          if (sql.includes('FROM buildings')) return [[{ id: 1 }]];
          if (sql.includes('id <>')) return [[]];
          throw new Error('UNEXPECTED_SQL');
        },
        updateById: async (table, id, fields) => calls.push({ table, id, fields })
      });
    };
    next();
  });
  app.use('/api', createRoomUpdateRouter('rental'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms/7', {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-operation-reason': 'Correct rent', 'idempotency-key': 'room-patch-request-001' },
      body: JSON.stringify({ rent: 1350 })
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].operation, 'update');
    assert.equal(calls[0].payload.id, 7);
    assert.equal(calls.at(-1).fields.rent, 1350);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
