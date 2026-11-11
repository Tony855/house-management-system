'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createRentalWriteRouter, validateRoom } = require('../services/rental-api/write-routes');

const valid = Object.freeze({ building_id: 7, room_no: '  A-101 ', rent: '1200.00', deposit: 1000 });

async function request(write, body = valid, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = write;
    next();
  });
  app.use('/api', createRentalWriteRouter());
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('validates a strict rental room DTO and rejects client-controlled columns', () => {
  const room = validateRoom(valid);
  assert.equal(room.building_id, 7);
  assert.equal(room.room_no, 'A-101');
  assert.equal(room.rent, 1200);
  assert.equal(room.status, 'vacant');
  for (const body of [
    { ...valid, org_id: 99 },
    { ...valid, id: 5 },
    { ...valid, status: 'deleted' },
    { ...valid, rent: -1 },
    { ...valid, room_no: ' ' },
    { ...valid, building_id: 0 }
  ]) assert.throws(() => validateRoom(body), error => error.code === 'ROOM_INPUT_INVALID');
});

test('POST /rooms delegates a validated payload to the transactional tenant write boundary', async () => {
  const calls = [];
  const response = await request(async input => {
    calls.push(input);
    const [buildings] = await input.mutate({
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return sql.includes('FROM buildings') ? [[{ id: 7 }]] : [[]];
      },
      insert: async (table, fields) => {
        calls.push({ table, fields });
        return { insertId: 88, affectedRows: 1 };
      }
    });
    return { id: 88, ...input.payload };
  }, valid, {
    'x-operation-reason': 'Create approved rental room',
    'x-step-up-token': 'step-up-token-123456789',
    'idempotency-key': 'request-id-00000001'
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).id, 88);
  assert.equal(calls[0].operation, 'create');
  assert.equal(calls[0].payload.room_no, 'A-101');
  assert.equal(calls[0].reason, 'Create approved rental room');
  assert.equal(calls[0].requestId, 'request-id-00000001');
});

test('POST /rooms returns 503 when the transactional write service is not configured', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createRentalWriteRouter());
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/rooms', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid)
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'TENANT_WRITE_UNAVAILABLE' });
  } finally {
    await new Promise(resolve => server.close(error => error ? reject(error) : resolve()));
  }
});

test('POST /rooms rejects invalid DTO before invoking the write service', async () => {
  let invoked = false;
  const response = await request(async () => { invoked = true; }, { ...valid, org_id: 999 });
  assert.equal(response.status, 400);
  assert.equal(invoked, false);
});
