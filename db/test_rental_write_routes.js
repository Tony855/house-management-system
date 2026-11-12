'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createRentalWriteRouter, validateRoom, validateContract, validateContractRenewal, buildNextRentalBill } = require('../services/rental-api/write-routes');

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
    const result = await input.mutate({
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return sql.includes('FROM buildings') ? [[{ id: 7 }]] : [[]];
      },
      insert: async (table, fields) => {
        calls.push({ table, fields });
        return { insertId: 88, affectedRows: 1 };
      }
    });
    return result;
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

test('rental contract validation rejects invalid dates, amounts and tenant-controlled columns', () => {
  const input = { contract_no: 'R-31', room_id: 3, tenant_id: 8, start_date: '2026-11-01', end_date: '2027-10-31', sign_date: '2026-10-30', rent: 1200, deposit: 1200 };
  assert.equal(validateContract(input).pay_cycle, 1);
  assert.equal(validateContract({ ...input, pay_cycle: 18 }).pay_cycle, 18);
  assert.equal(validateContract({ ...input, pay_cycle: 36 }).pay_cycle, 36);
  for (const bad of [{ ...input, org_id: 5 }, { ...input, end_date: '2026-10-01' }, { ...input, start_date: '2026-02-30' }, { ...input, rent: -1 }, { ...input, pay_cycle: 37 }, { ...input, pay_cycle: 0.5 }]) {
    assert.throws(() => validateContract(bad), error => error.code === 'CONTRACT_INPUT_INVALID');
  }
});

test('POST /contracts uses transaction boundary and marks its vacant room rented', async () => {
  const calls = [];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.tenantWrite = async input => { calls.push(input); return input.mutate({
    execute: async sql => sql.includes('FROM rooms') ? [[{ id: 3, status: 'vacant' }]] : sql.includes('FROM tenants') ? [[{ id: 8 }]] : [[]],
    insert: async (table, fields) => { calls.push({ table, fields }); return { insertId: 31 }; },
    updateById: async (table, id, fields) => { calls.push({ table, id, fields }); return { affectedRows: 1 }; }
  }); }; next(); });
  app.use('/api', createRentalWriteRouter());
  app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts',{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Sign rental agreement','x-step-up-token':'step-up-token-123456789','idempotency-key':'contract-create-0001'},body:JSON.stringify({contract_no:'R-31',room_id:3,tenant_id:8,start_date:'2026-11-01',end_date:'2027-10-31',sign_date:'2026-10-30',rent:1200,deposit:1200})});
    assert.equal(response.status,201); assert.equal((await response.json()).id,31);
    assert.equal(calls[0].payload.__resource,'contracts');
    assert.ok(calls.some(x=>x.table==='rooms'&&x.fields.status==='rented'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('rental bill period follows contract cycle, clamps final period and rejects future/finished periods', () => {
  const contract = { id: 9, contract_no: 'R-9', room_id: 3, tenant_id: 8, start_date: '2026-01-31', end_date: '2026-12-31', rent: '1200.00', pay_cycle: 1, status: 'active' };
  const first = buildNextRentalBill(contract, null, '2026-02-28');
  assert.equal(first.period_start, '2026-01-31');
  assert.equal(first.period_end, '2026-02-27');
  assert.equal(first.amount, 1200);
  const next = buildNextRentalBill({ ...contract, pay_cycle: 3 }, '2026-02-27', '2026-05-01');
  assert.equal(next.period_start, '2026-02-28');
  assert.equal(next.period_end, '2026-05-27');
  assert.equal(next.amount, 3600);
  const final = buildNextRentalBill({ ...contract, start_date: '2026-11-01', pay_cycle: 3 }, '2026-11-30', '2026-12-01');
  assert.equal(final.period_end, '2026-12-31');
  assert.equal(final.amount, 3600);
  assert.throws(() => buildNextRentalBill({ ...contract, start_date: '2027-01-01' }, null, '2026-12-01'), e => e.code === 'RENTAL_BILL_NOT_DUE');
  assert.throws(() => buildNextRentalBill(contract, '2026-12-31', '2027-01-01'), e => e.code === 'CONTRACT_PERIOD_FINISHED');
  assert.throws(() => buildNextRentalBill({ ...contract, status: 'terminated' }, null, '2026-02-01'), e => e.code === 'CONTRACT_NOT_ACTIVE');
});

test('POST /contracts/:id/generate-bill locks contract and creates next period inside tenant write boundary', async () => {
  const calls=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async sql=>sql.includes('FROM contracts')?[[{id:9,contract_no:'R-9',room_id:3,tenant_id:8,start_date:'2026-01-01',end_date:'2026-12-31',rent:'1200.00',pay_cycle:1,status:'active'}]]:[[]],
    insert:async(table,fields)=>{calls.push({table,fields});return {insertId:91};}
  });};next();});
  app.use('/api',createRentalWriteRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts/9/generate-bill',{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Generate next contract rent bill','x-step-up-token':'step-up-token-123456789','idempotency-key':'rental-bill-generate-0001'},body:'{}'});
    assert.equal(response.status,201); const body=await response.json();
    assert.equal(body.id,91); assert.equal(body.source,'rental'); assert.equal(body.contract_id,9);
    assert.equal(calls[0].payload.__resource,'rental-bills');
    assert.ok(calls.some(x=>x.table==='bills'&&x.fields.amount===1200));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});


test('rental contract renewal accepts only an extension and bounded optional terms', () => {
  assert.deepEqual(validateContractRenewal({ end_date: '2028-12-31', rent: 1350, deposit: 1400, pay_cycle: 3 }), {
    end_date: '2028-12-31', rent: 1350, deposit: 1400, pay_cycle: 3
  });
  for (const bad of [{ end_date: '2028-02-30' }, { end_date: '2028-12-31', status: 'expired' },
    { end_date: '2028-12-31', rent: -1 }, { end_date: '2028-12-31', pay_cycle: 37 }, {}]) {
    assert.throws(() => validateContractRenewal(bad), e => e.code === 'CONTRACT_RENEWAL_INPUT_INVALID');
  }
});

test('POST /contracts/:id/renew locks active contract and records changed terms through tenant write audit boundary', async () => {
  const calls=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async()=>[[{id:9,contract_no:'R-9',room_id:3,tenant_id:8,start_date:'2026-01-01',end_date:'2026-12-31',rent:'1200.00',deposit:'500.00',pay_cycle:1,status:'active'}]],
    updateById:async(table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createRentalWriteRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts/9/renew',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Renew rental agreement','x-step-up-token':'step-up-token-123456789','idempotency-key':'rental-renew-0001'},
      body:JSON.stringify({end_date:'2027-12-31',rent:1350,deposit:600,pay_cycle:3})});
    assert.equal(response.status,200); const body=await response.json();
    assert.equal(body.previous_end_date,'2026-12-31'); assert.equal(body.end_date,'2027-12-31'); assert.equal(body.rent,1350);
    assert.equal(calls[0].payload.__resource,'contract-renewals');
    assert.deepEqual(calls.find(x=>x.table==='contracts').fields,{end_date:'2027-12-31',rent:1350,deposit:600,pay_cycle:3});
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('contract renewal cannot shorten the current term or renew an inactive contract', async () => {
  const makeApp = status => { const app=express(); app.use(express.json()); app.use((req,_res,next)=>{req.tenantWrite=async input=>input.mutate({
    execute:async()=>[[{id:9,room_id:3,end_date:'2026-12-31',status}]], updateById:async()=>({affectedRows:1})
  });next();}); app.use('/api',createRentalWriteRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'})); return app; };
  for (const [status,endDate,expected] of [['active','2026-12-30','CONTRACT_RENEWAL_MUST_EXTEND'],['expired','2027-12-31','CONTRACT_NOT_ACTIVE']]) {
    const server=http.createServer(makeApp(status)); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts/9/renew',{method:'POST',
        headers:{'content-type':'application/json','x-operation-reason':'Renew rental agreement','x-step-up-token':'step-up-token-123456789','idempotency-key':'rental-renew-reject-'+status},
        body:JSON.stringify({end_date:endDate})});
      assert.equal(response.status,409); assert.equal((await response.json()).error,expected);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  }
});
