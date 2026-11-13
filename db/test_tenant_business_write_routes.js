'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createTenantBusinessWriteRouter, validateTenant, validateRepair } = require('../services/shared/tenant-business-write-routes');

async function request(appId, method, path, body, mutate) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = async input => input.mutate({
      execute: async sql => sql.includes('FROM tenants') ? [[{ id: 4 }]] :
        sql.includes('FROM repairs') ? [[{ id: 9, status: 'pending' }]] :
        sql.includes('FROM rooms') ? [[{ id: 2 }]] : [[]],
      insert: async () => ({ insertId: 17 }),
      updateById: async () => ({ affectedRows: 1 })
    });
    next();
  });
  app.use('/api', createTenantBusinessWriteRouter(appId));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fetch('http://127.0.0.1:' + server.address().port + path, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('rental and hotel tenant DTOs validate natural person fields', () => {
  for (const appId of ['rental', 'hotel']) {
    const row = validateTenant(appId, { name: 'Guest', gender: '女', phone: '123', id_card: 'ID-1' });
    assert.equal(row.gender, '女');
    assert.equal(Object.hasOwn(row, 'license_no'), false);
  }
});
test('property tenant DTO represents a company, not a natural person', () => {
  const row = validateTenant('property', { name: 'Company', contact: 'Admin', phone: '123', license_no: 'LIC-1' });
  assert.equal(row.contact, 'Admin');
  assert.equal(Object.hasOwn(row, 'gender'), false);
  assert.throws(() => validateTenant('property', { name: 'Company', gender: '男' }), e => e.code === 'TENANT_INPUT_INVALID');
});
test('tenant DTO rejects org and arbitrary database fields', () => {
  assert.throws(() => validateTenant('rental', { name: 'X', org_id: 7 }), e => e.code === 'TENANT_INPUT_INVALID');
  assert.throws(() => validateTenant('hotel', { name: '' }), e => e.code === 'TENANT_INPUT_INVALID');
});
test('repair DTO rejects invalid status and unknown fields', () => {
  assert.throws(() => validateRepair({ room_id: 1, title: 'Broken', status: 'deleted' }), e => e.code === 'REPAIR_INPUT_INVALID');
  assert.throws(() => validateRepair({ room_id: 1, title: 'Broken', org_id: 8 }), e => e.code === 'REPAIR_INPUT_INVALID');
});
test('POST tenant and repair writes use transactional tenant write boundary', async () => {
  const tenant = await request('rental', 'POST', '/api/tenants', { name: 'Resident', gender: '男' });
  assert.equal(tenant.status, 201);
  assert.equal((await tenant.json()).id, 17);
  const repair = await request('hotel', 'POST', '/api/repairs', { room_id: 2, title: 'Air conditioner' });
  assert.equal(repair.status, 201);
  assert.equal((await repair.json()).status, 'pending');
});
test('repair status transition rejects skipping processing', async () => {
  const response = await request('property', 'PATCH', '/api/repairs/9', { status: 'done' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'REPAIR_STATUS_TRANSITION_INVALID' });
});
