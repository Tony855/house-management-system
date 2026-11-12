'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createBuildingWriteRouter, validateBuilding } = require('../services/shared/building-write-routes');

test('building DTO rejects protected columns and normalizes public text fields', () => {
  assert.deepEqual(validateBuilding({ name: '  Tower A ', address: ' Phnom Penh ' }), { name: 'Tower A', address: 'Phnom Penh' });
  assert.throws(() => validateBuilding({ name: 'A', org_id: 9 }), /BUILDING_INPUT_INVALID/);
  assert.throws(() => validateBuilding({ name: ' ' }), /BUILDING_INPUT_INVALID/);
});

test('building create/update use tenant write transaction, idempotency and duplicate checks', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = async input => {
      calls.push(input);
      return input.mutate({
        execute: async (sql, params) => {
          if (sql.includes('SELECT id FROM buildings WHERE name = ?')) return [params[0] === 'Tower A' ? [] : [], []];
          if (sql.includes('SELECT id, name, address, remark')) return [[{ id: 5, name: 'Tower A', address: '', remark: '' }], []];
          if (sql.includes('AND id <>')) return [[], []];
          throw new Error('UNEXPECTED_SQL');
        },
        insert: async () => ({ insertId: 6 }),
        updateById: async (table, id, fields) => calls.push({ table, id, fields })
      });
    };
    next();
  });
  app.use('/api', createBuildingWriteRouter());
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const headers = { 'content-type': 'application/json', 'x-operation-reason': 'Approved building maintenance', 'idempotency-key': 'building-write-request-01' };
    const created = await fetch('http://127.0.0.1:' + server.address().port + '/api/buildings', { method: 'POST', headers, body: JSON.stringify({ name: 'Tower A' }) });
    assert.equal(created.status, 201);
    const updated = await fetch('http://127.0.0.1:' + server.address().port + '/api/buildings/5', { method: 'PATCH', headers, body: JSON.stringify({ address: 'Phnom Penh' }) });
    assert.equal(updated.status, 200);
    assert.equal(calls[0].operation, 'create');
    assert.equal(calls[1].operation, 'update');
    assert.equal(calls[2].fields.address, 'Phnom Penh');
  } finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
