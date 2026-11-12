'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateProductRoom } = require('../services/shared/product-room-write-routes');
const { validateHotelOrder, createHotelOrderRouter } = require('../services/hotel-api/order-routes');
const { validateMeter, createMeterWriteRouter } = require('../services/shared/meter-write-routes');
const { validateBillPayment, createBillPaymentRouter } = require('../services/shared/bill-payment-routes');
const { validateReconciliationRange, createFinanceReconciliationRouter } = require('../services/shared/finance-reconciliation-routes');
const { validatePropertyFeeGeneration, monthDates, createPropertyFeeRouter } = require('../services/shared/property-fee-routes');
const http = require('node:http');
const express = require('express');

test('hotel room DTO accepts hotel-only pricing and status fields', () => {
  const room = validateProductRoom('hotel', { building_id: 1, room_no: 'H-101', day_price: 50, deposit: 20, status: 'booked' });
  assert.equal(room.day_price, 50);
  assert.equal(room.status, 'booked');
  assert.equal(Object.hasOwn(room, 'rent'), false);
});
test('property room DTO accepts owner and property fee fields', () => {
  const room = validateProductRoom('property', { building_id: 2, room_no: 'P-201', owner_id: 8, property_fee: 120, water_price: 2, elec_price: 1.5 });
  assert.equal(room.owner_id, 8);
  assert.equal(room.property_fee, 120);
  assert.equal(Object.hasOwn(room, 'day_price'), false);
});
test('hotel and property reject cross-product and tenant-controlled fields', () => {
  assert.throws(() => validateProductRoom('hotel', { building_id: 1, room_no: '1', rent: 20 }), e => e.code === 'ROOM_INPUT_INVALID');
  assert.throws(() => validateProductRoom('property', { building_id: 1, room_no: '1', org_id: 5 }), e => e.code === 'ROOM_INPUT_INVALID');
  assert.throws(() => validateProductRoom('property', { building_id: 1, room_no: '1', owner_id: -1 }), e => e.code === 'ROOM_INPUT_INVALID');
});
test('invalid floor, money, status and oversized remarks are rejected', () => {
  for (const body of [
    { building_id: 1, room_no: '1', floor: 1.23 },
    { building_id: 1, room_no: '1', day_price: -1 },
    { building_id: 1, room_no: '1', status: 'deleted' },
    { building_id: 1, room_no: '1', remark: 'x'.repeat(201) }
  ]) assert.throws(() => validateProductRoom('hotel', body), e => e.code === 'ROOM_INPUT_INVALID');
});

test('hotel order DTO rejects invalid dates and client-supplied pricing or status', () => {
  const valid = { order_no: 'H-100', room_id: 4, guest_id: 8, check_in_date: '2026-11-15', check_out_date: '2026-11-18' };
  assert.equal(validateHotelOrder(valid).days, 3);
  for (const bad of [{ ...valid, total: 20 }, { ...valid, status: 'checked_in' }, { ...valid, check_out_date: '2026-11-14' }, { ...valid, check_in_date: '2026-02-30' }]) {
    assert.throws(() => validateHotelOrder(bad), e => e.code === 'HOTEL_ORDER_INPUT_INVALID');
  }
});
test('hotel order creation derives price from locked room and updates room status transactionally', async () => {
  const calls = [];
  const app = express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute: async sql => sql.includes('FROM rooms') ? [[{id:4,day_price:80,deposit:30,status:'vacant'}]] : sql.includes('FROM tenants') ? [[{id:8}]] : [[]],
    insert: async (table,fields)=>{calls.push({table,fields});return {insertId:22};},
    updateById: async (table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createHotelOrderRouter());
  app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/orders',{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Create hotel reservation','x-step-up-token':'step-up-token-123456789','idempotency-key':'hotel-order-create-0001'},body:JSON.stringify({order_no:'H-100',room_id:4,guest_id:8,check_in_date:'2026-11-15',check_out_date:'2026-11-18'})});
    assert.equal(response.status,201);const body=await response.json();assert.equal(body.total,240);assert.equal(body.deposit,30);
    assert.equal(calls[0].payload.__resource,'orders');assert.ok(calls.some(x=>x.table==='rooms'&&x.fields.status==='booked'));
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('hotel order status transitions are constrained and room state follows lifecycle', async () => {
  const calls=[];const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async sql=>sql.includes('FROM orders')?[[{id:22,room_id:4,guest_id:8,order_no:'H-100',check_in_date:'2026-11-15',check_out_date:'2026-11-18',total:240,status:'booked'}]]:[[]],
    insert:async(table,fields)=>{calls.push({table,fields});return {insertId:9};},
    updateById:async(table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createHotelOrderRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/orders/22/status',{method:'PATCH',headers:{'content-type':'application/json','x-operation-reason':'Check in hotel guest','x-step-up-token':'step-up-token-123456789','idempotency-key':'hotel-order-status-0001'},body:JSON.stringify({status:'checked_in'})});
    assert.equal(response.status,200);assert.ok(calls.some(x=>x.table==='rooms'&&x.fields.status==='rented'));
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('meter DTO validates monotonic readings and rejects client-calculated fees', () => {
  const valid = { room_id: 4, month: '2030-01', water_prev: 10, water_curr: 12.5, elec_prev: 20, elec_curr: 23 };
  assert.equal(validateMeter(valid).water_curr, 12.5);
  for (const bad of [{ ...valid, water_fee: 999 }, { ...valid, month: '2030-13' }, { ...valid, water_curr: 9 }, { ...valid, elec_curr: 19 }]) {
    assert.throws(() => validateMeter(bad), e => e.code === 'METER_INPUT_INVALID');
  }
});
test('meter creation derives fees from locked room rates and previous reading', async () => {
  const calls=[];const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async sql=>sql.includes('FROM rooms')?[[{id:4,water_price:2,elec_price:1.5}]]:sql.includes('month <')?[[{month:'2029-12',water_curr:10,elec_curr:20}]]:[[]],
    insert:async(table,fields)=>{calls.push({table,fields});return {insertId:12};}
  });};next();});
  app.use('/api',createMeterWriteRouter('rental'));app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/meters',{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Record monthly meter','x-step-up-token':'step-up-token-123456789','idempotency-key':'meter-create-0001'},body:JSON.stringify({room_id:4,month:'2030-01',water_prev:10,water_curr:12.5,elec_prev:20,elec_curr:23})});
    assert.equal(response.status,201);const body=await response.json();assert.equal(body.water_fee,5);assert.equal(body.elec_fee,4.5);
    assert.equal(calls[0].payload.__resource,'meters');assert.ok(calls.some(x=>x.table==='meters'&&x.fields.water_usage===2.5));
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('bill payment DTO rejects invalid amounts and client-controlled balance fields', () => {
  assert.equal(validateBillPayment({ amount: 12.5, pay_method: 'cash', pay_date: '2030-01-31' }).amount, 12.5);
  for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 1.001 }, { amount: 20, paid_amount: 100 }, { amount: 20, status: 'paid' }, { amount: 20, pay_date: '2030-02-30' }]) {
    assert.throws(() => validateBillPayment(bad), e => e.code === 'BILL_PAYMENT_INPUT_INVALID');
  }
});
test('bill payment applies partial and final settlement under a locked balance', async () => {
  const calls=[];const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async()=>[[{id:8,amount:'100.00',paid_amount:'25.00',status:'partial',room_id:4,pay_method:'cash'}]],
    updateById:async(table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createBillPaymentRouter('rental'));app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/bills/8/pay',{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Record partial bill payment','x-step-up-token':'step-up-token-123456789','idempotency-key':'bill-payment-0001'},body:JSON.stringify({amount:30,pay_method:'bank',pay_date:'2030-01-31'})});
    assert.equal(response.status,200);const body=await response.json();assert.equal(body.paid_amount,55);assert.equal(body.remaining,45);assert.equal(body.status,'partial');
    assert.equal(calls[0].payload.__resource,'bill-payments');assert.ok(calls.some(x=>x.table==='bills'&&x.fields.paid_amount===55));
  } finally {await new Promise(resolve=>server.close(resolve));}
});


test('property fee generation validates a strict month-only request', () => {
  assert.deepEqual(validatePropertyFeeGeneration({ month: '2030-02' }), { month: '2030-02' });
  assert.deepEqual(monthDates('2030-02'), { start: '2030-02-01', end: '2030-02-28', due: '2030-02-10' });
  for (const bad of [{ month: '2030-13' }, { month: '2030-2' }, { month: '2030-02', amount: 1 }, {}, null]) {
    assert.throws(() => validatePropertyFeeGeneration(bad), e => e.code === 'PROPERTY_FEE_INPUT_INVALID');
  }
});

test('property fee generation creates owner receivable from server-side property fee and meter charges', async () => {
  const calls = [];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantWrite = async input => {
      calls.push(input);
      return input.mutate({
        execute: async (sql, params) => {
          calls.push({ sql, params });
          if (sql.includes('FROM rooms')) return [[
            { room_id: 4, owner_id: 8, room_no: 'P-401', property_fee: '100.00', water_fee: '5.00', elec_fee: '4.50' },
            { room_id: 5, owner_id: 9, room_no: 'P-402', property_fee: '0.00', water_fee: '0.00', elec_fee: '0.00' }
          ]];
          return [[]];
        },
        insert: async (table, fields) => {
          calls.push({ table, fields });
          return { insertId: 41 };
        }
      });
    };
    next();
  });
  app.use('/api', createPropertyFeeRouter());
  app.use((e, _q, res, _n) => res.status(e.status || 500).json({ error: e.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/property-fees/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operation-reason': 'Generate monthly property receivables',
        'x-step-up-token': 'step-up-token-123456789', 'idempotency-key': 'property-fees-2030-02' },
      body: JSON.stringify({ month: '2030-02' })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.generated, 1);
    assert.equal(body.skipped, 1);
    assert.equal(body.bills[0].id, 41);
    assert.equal(body.bills[0].tenant_id, 8);
    assert.equal(body.bills[0].amount, 109.5);
    assert.equal(body.bills[0].period_end, '2030-02-28');
    assert.equal(calls[0].payload.__resource, 'property-bills');
    const inserted = calls.find(call => call.table === 'bills');
    assert.equal(inserted.fields.source, 'property');
    assert.equal(inserted.fields.remark, '明细：物业费 100.00 + 水费 5.00 + 电费 4.50');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('finance reconciliation validates a bounded inclusive date range', () => {
  assert.deepEqual(validateReconciliationRange({ from_date: '2030-01-01', to_date: '2030-12-31' }), {
    from_date: '2030-01-01', to_date: '2030-12-31'
  });
  for (const query of [{ from_date: '2030-02-30', to_date: '2030-03-01' },
    { from_date: '2030-03-02', to_date: '2030-03-01' },
    { from_date: '2028-01-01', to_date: '2030-01-01' }]) {
    assert.throws(() => validateReconciliationRange(query), e => e.code.startsWith('FINANCE_RECONCILIATION_'));
  }
});

test('finance reconciliation runs against the authenticated tenant database and reports ledger mismatches', async () => {
  const calls=[]; const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{
    calls.push({sql,params});
    return [[{source:'rental',bills_count:4,receipts:'100.00',refunds:'20.00',net_transactions:'80.00',mismatch_count:0}]];
  }};next();});
  app.use('/api',createFinanceReconciliationRouter('rental'));
  app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/finance/reconciliation?from_date=2030-01-01&to_date=2030-12-31');
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body.totals,{bills_count:4,receipts:100,refunds:20,net_transactions:80,mismatch_count:0});
    assert.deepEqual(calls[0].params,['2030-01-01','2030-12-31','2030-01-01','2030-12-31']);
    assert.match(calls[0].sql,/FROM bill_transactions/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});


test('hotel cleaning completion requires a cleaning room and no active orders', async () => {
  const calls=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async sql=>sql.includes('FROM rooms')?[[{id:12,status:'cleaning'}]]:[[]],
    updateById:async(table,id,fields)=>{calls.push({table,id,fields});return {affectedRows:1};}
  });};next();});
  app.use('/api',createHotelOrderRouter()); app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/rooms/12/cleaning-complete',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Complete hotel room cleaning','x-step-up-token':'step-up-token-123456789','idempotency-key':'hotel-cleaning-0001'},body:'{}'});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{room_id:12,status:'vacant'});
    assert.equal(calls[0].payload.__resource,'hotel-room-cleaning');
    assert.ok(calls.some(x=>x.table==='rooms'&&x.fields.status==='vacant'));
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('hotel cleaning completion rejects a room that is not in cleaning state', async () => {
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=input=>input.mutate({
    execute:async()=>[[{id:12,status:'vacant'}]],updateById:async()=>{throw new Error('must not change room');}
  });next();});
  app.use('/api',createHotelOrderRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/rooms/12/cleaning-complete',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Complete hotel room cleaning','x-step-up-token':'step-up-token-123456789','idempotency-key':'hotel-cleaning-invalid-0001'},body:'{}'});
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'ROOM_NOT_IN_CLEANING'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});


test('property arrears report validates its as-of date and returns outstanding balances', async () => {
  const app=express(); app.use((req,_res,next)=>{req.tenantDb={execute:async(_sql,params)=>{
    assert.deepEqual(params,['2030-02-01','2030-02-01']);
    return [[{id:41,source:'property',room_id:4,room_no:'P-401',owner_id:8,tenant_id:8,tenant_name:'Owner Ltd',
      due_date:'2030-01-10',amount:'109.50',paid_amount:'9.50',outstanding_amount:'100.00',days_overdue:22}]];
  }};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/arrears?as_of=2030-02-01');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.overdue_count,1);assert.equal(body.total_outstanding,100);
    assert.equal(body.items[0].days_overdue,22);assert.equal(body.items[0].tenant_name,'Owner Ltd');
    const invalid=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/arrears?as_of=2030-02-30');
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'PROPERTY_ARREARS_DATE_INVALID'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
