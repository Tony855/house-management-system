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


test('POST /contracts/:id/terminate requires settled rent bills and leaves deposit settlement explicitly pending', async () => {
  const calls=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async (sql)=> {
      if(sql.includes('id <> ?')) return [[]];
      if(sql.includes('outstanding_count')) return [[{outstanding_count:0,outstanding_amount:'0.00'}]];
      if(sql.includes('FROM contracts')) return [[{id:9,room_id:3,tenant_id:8,start_date:'2026-01-01',end_date:'2026-12-31',deposit:'500.00',status:'active'}]];
      return [[]];
    },
    updateById:async(table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createRentalWriteRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR',details:e.details}));
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts/9/terminate',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Early terminate rental','x-step-up-token':'step-up-token-123456789','idempotency-key':'rental-terminate-0001'},
      body:JSON.stringify({termination_date:new Date().toISOString().slice(0,10)})});
    assert.equal(response.status,200); const body=await response.json();
    assert.equal(body.status,'terminated'); assert.equal(body.deposit_settlement.status,'pending');
    assert.equal(body.deposit_settlement.deposit_amount,500);
    assert.equal(calls[0].payload.__resource,'contract-terminations');
    assert.ok(calls.some(x=>x.table==='contracts'&&x.fields.status==='terminated'));
    assert.ok(calls.some(x=>x.table==='rooms'&&x.fields.status==='vacant'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('rental termination rejects contracts with unpaid bills and does not change contract state', async () => {
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>input.mutate({
    execute:async sql=>sql.includes('FROM contracts')
      ? [[{id:9,room_id:3,start_date:'2026-01-01',end_date:'2026-12-31',deposit:'500.00',status:'active'}]]
      : [[{outstanding_count:1,outstanding_amount:'120.00'}]],
    updateById:async()=>{throw new Error('must not update with outstanding bills');}
  });next();});
  app.use('/api',createRentalWriteRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR',details:e.details}));
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/contracts/9/terminate',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Early terminate rental','x-step-up-token':'step-up-token-123456789','idempotency-key':'rental-terminate-blocked-0001'},
      body:JSON.stringify({termination_date:new Date().toISOString().slice(0,10)})});
    assert.equal(response.status,409); const body=await response.json();
    assert.equal(body.error,'CONTRACT_HAS_OUTSTANDING_BILLS');
    assert.equal(body.details.outstanding_amount,120);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('rental deposit transaction DTO requires cash method or deduction reason and rejects client balances', () => {
  const { validateRentalDepositTransaction } = require('../services/rental-api/write-routes');
  assert.equal(validateRentalDepositTransaction({ amount: 20, pay_method: 'cash', transaction_date: '2030-01-01' }, 'receipt').amount, 20);
  assert.equal(validateRentalDepositTransaction({ amount: 5, note: 'Damage' }, 'deduction').amount, 5);
  for (const [body, action] of [
    [{ amount: 0, pay_method: 'cash' }, 'receipt'],
    [{ amount: 10, pay_method: 'cash', held_amount: 99 }, 'refund'],
    [{ amount: 10 }, 'receipt'],
    [{ amount: 10, note: '' }, 'deduction'],
    [{ amount: 10, pay_method: 'cash', transaction_date: '2030-02-30' }, 'refund']
  ]) assert.throws(() => validateRentalDepositTransaction(body, action), e => e.code === 'RENTAL_DEPOSIT_INPUT_INVALID');
});
test('rental deposit receipts, refunds and deductions enforce contract state and held balance', async () => {
  const app=express();app.use(express.json());const ledger=[];let contractStatus='active';
  app.use((req,_res,next)=>{req.tenantWrite=async input=>input.mutate({execute:async(sql,params)=>{
    if(sql.includes('FROM contracts')) return [[{id:9,deposit:'50.00',status:contractStatus}]];
    if(sql.includes('SUM(CASE WHEN transaction_type')) {
      const sum=type=>ledger.filter(x=>x.type===type).reduce((n,x)=>n+x.amount,0);
      return [[{received_amount:sum('receipt'),refunded_amount:sum('refund'),deducted_amount:sum('deduction')}]];
    }
    if(sql.includes('INSERT INTO rental_contract_deposit_transactions')) {ledger.push({type:params[1],amount:params[2]});return [{affectedRows:1}];}
    return [[]];
  }});next();});
  app.use('/api',createRentalWriteRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const send=(path,body,key)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Rental deposit ledger','x-step-up-token':'step-up-token-123456789','idempotency-key':key},body:JSON.stringify(body)});
  try {
    const receipt=await send('/api/contracts/9/deposit/receive',{amount:50,pay_method:'cash'},'rental-deposit-receipt-0001');
    assert.equal(receipt.status,201);assert.equal((await receipt.json()).held_amount,50);
    contractStatus='terminated';
    const refund=await send('/api/contracts/9/deposit/refund',{amount:20,pay_method:'bank'},'rental-deposit-refund-0001');
    assert.equal(refund.status,201);assert.equal((await refund.json()).held_amount,30);
    const deduction=await send('/api/contracts/9/deposit/deduct',{amount:5,note:'Damage'},'rental-deposit-deduct-0001');
    assert.equal(deduction.status,201);assert.equal((await deduction.json()).held_amount,25);
    const excess=await send('/api/contracts/9/deposit/refund',{amount:26,pay_method:'bank'},'rental-deposit-refund-0002');
    assert.equal(excess.status,409);
    assert.equal(ledger.length,3);
  } finally {await new Promise(resolve=>server.close(resolve));}
});


test('tenant-wide rental bill batch is bounded, resumable by contract cursor and skips future periods', async () => {
  const app = express();
  app.use(express.json());
  const created = [];
  const calls = [];
  const contracts = [
    { id: 3, room_id: 10, tenant_id: 20, contract_no: 'R-3', start_date: '2026-01-01', end_date: '2027-12-31', rent: '100.00', pay_cycle: 1, status: 'active' },
    { id: 4, room_id: 11, tenant_id: 21, contract_no: 'R-4', start_date: '2027-01-01', end_date: '2027-12-31', rent: '200.00', pay_cycle: 1, status: 'active' },
    { id: 5, room_id: 12, tenant_id: 22, contract_no: 'R-5', start_date: '2026-02-01', end_date: '2027-12-31', rent: '300.00', pay_cycle: 1, status: 'active' }
  ];
  app.use((req, _res, next) => {
    req.tenantWrite = async input => {
      calls.push(input);
      return input.mutate({
        execute: async (sql, params) => {
          if (sql.includes("FROM contracts WHERE status = 'active'")) {
            assert.equal(params[0], 0);
            assert.equal(params[1], 3);
            return [contracts];
          }
          if (sql.includes('FROM bills WHERE contract_id')) {
            return [params[0] === 3 ? [{ period_end: '2026-10-31' }] : []];
          }
          throw new Error('UNEXPECTED_SQL');
        },
        insert: async (_table, bill) => {
          created.push(bill);
          return { insertId: created.length };
        }
      });
    };
    next();
  });
  app.use('/api', createRentalWriteRouter());
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/rental-bills/generate-due', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operation-reason': 'Monthly rental bill batch', 'x-step-up-token': 'step-up-token-123456789', 'idempotency-key': 'rental-bill-batch-000001' },
      body: JSON.stringify({ as_of: '2026-11-12', after_contract_id: 0, limit: 2 })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.processed_count, 2);
    assert.equal(payload.generated_count, 1);
    assert.equal(payload.skipped_count, 1);
    assert.equal(payload.next_after_contract_id, 4);
    assert.equal(payload.has_more, true);
    assert.equal(created[0].contract_id, 3);
    assert.equal(created[0].period_start, '2026-11-01');
    assert.equal(created[0].amount, 100);
    assert.equal(calls[0].payload.__resource, 'rental-bill-batch');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('tenant-wide rental bill batch rejects unbounded limits and invalid cursors before writing', async () => {
  let writes = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantWrite = async () => { writes++; }; next(); });
  app.use('/api', createRentalWriteRouter());
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const body of [{ limit: 5000 }, { after_contract_id: -1 }, { as_of: '2026-02-30' }, { unexpected: true }]) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/rental-bills/generate-due', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
    }
    assert.equal(writes, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
