'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateProductRoom } = require('../services/shared/product-room-write-routes');
const { validateHotelOrder, createHotelOrderRouter } = require('../services/hotel-api/order-routes');
const { validateMeter, createMeterWriteRouter } = require('../services/shared/meter-write-routes');
const { validateBillPayment, createBillPaymentRouter } = require('../services/shared/bill-payment-routes');
const { validateReconciliationRange, createFinanceReconciliationRouter } = require('../services/shared/finance-reconciliation-routes');
const { validatePropertyFeeGeneration, validatePropertyCollectionAction, validatePropertyFeeJobId, monthDates, createPropertyFeeRouter } = require('../services/shared/property-fee-routes');
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


test('property arrears report is property-scoped, paginated and returns complete aging totals', async () => {
  const calls=[]; const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('COUNT(*) AS total_count')) return [[{total_count:125}]];
    if(sql.includes('AS days_1_30')) return [[{overdue_count:125,total_outstanding:'12500.00',days_1_30:'1000.00',days_31_60:'2000.00',days_61_90:'3000.00',days_over_90:'6500.00'}]];
    return [[{id:41,source:'property',room_id:4,room_no:'P-401',owner_id:8,tenant_id:8,tenant_name:'Owner Ltd',
      due_date:'2030-01-10',amount:'109.50',paid_amount:'9.50',outstanding_amount:'100.00',days_overdue:22}]];
  }};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/arrears?as_of=2030-02-01&page=2&page_size=25');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.page,2);assert.equal(body.page_size,25);assert.equal(body.total_count,125);
    assert.equal(body.overdue_count,125);assert.equal(body.total_outstanding,12500);
    assert.deepEqual(body.aging,{days_1_30:1000,days_31_60:2000,days_61_90:3000,days_over_90:6500});
    assert.equal(body.items.length,1);assert.equal(body.items[0].days_overdue,22);
    assert.ok(calls.every(call=>call.sql.includes("b.source = 'property'")));
    assert.deepEqual(calls[0].params,['2030-02-01']);
    assert.deepEqual(calls[2].params,['2030-02-01','2030-02-01',25,25]);
    const invalid=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/arrears?page=0');
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'PROPERTY_ARREARS_PAGINATION_INVALID'});
    const invalidDate=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/arrears?as_of=2030-02-30');
    assert.equal(invalidDate.status,400);assert.deepEqual(await invalidDate.json(),{error:'PROPERTY_ARREARS_DATE_INVALID'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('property collection action DTO validates channels, outcomes, dates and promised follow-up', () => {
  assert.deepEqual(validatePropertyCollectionAction({ action_type: 'phone', outcome: 'promised', contacted_at: '2030-02-01', follow_up_date: '2030-02-08', note: 'Call next week' }),
    { action_type: 'phone', outcome: 'promised', contacted_at: '2030-02-01', follow_up_date: '2030-02-08', note: 'Call next week' });
  for (const bad of [
    { action_type: 'fax', outcome: 'sent', contacted_at: '2030-02-01' },
    { action_type: 'phone', outcome: 'unknown', contacted_at: '2030-02-01' },
    { action_type: 'phone', outcome: 'promised', contacted_at: '2030-02-01' },
    { action_type: 'phone', outcome: 'reached', contacted_at: '2030-02-30' },
    { action_type: 'phone', outcome: 'reached', contacted_at: '2030-02-02', follow_up_date: '2030-02-01' },
    { action_type: 'phone', outcome: 'sent', contacted_at: '2030-02-01', extra: true }
  ]) assert.throws(() => validatePropertyCollectionAction(bad), e => e.code === 'PROPERTY_COLLECTION_INPUT_INVALID');
});
test('property collection action records only an overdue unsettled property bill under tenantWrite', async () => {
  const calls=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async(sql,params)=>{calls.push({sql,params});return sql.includes('FROM bills')?[[{id:41,source:'property',due_date:'2030-01-10',amount:'100.00',paid_amount:'20.00'}]]:[{insertId:88}];}
  });};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/41/collection-actions',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Record owner collection follow-up','x-step-up-token':'step-up-token-123456789','idempotency-key':'property-collection-0001'},
      body:JSON.stringify({action_type:'phone',outcome:'promised',contacted_at:'2030-02-01',follow_up_date:'2030-02-08',note:'Owner promises payment'})});
    assert.equal(response.status,201);const body=await response.json();assert.equal(body.id,88);assert.equal(body.bill_id,41);
    assert.equal(calls[0].payload.__resource,'property-collection-actions');
    assert.match(calls[1].sql,/FOR UPDATE/);
    assert.match(calls[2].sql,/INSERT INTO property_collection_actions/);
    const settledApp=express();settledApp.use(express.json());
    settledApp.use((req,_res,next)=>{req.tenantWrite=input=>input.mutate({execute:async()=>[[{id:41,source:'property',due_date:'2030-01-10',amount:'100.00',paid_amount:'100.00'}]]});next();});
    settledApp.use('/api',createPropertyFeeRouter());settledApp.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
    const settledServer=http.createServer(settledApp);await new Promise(resolve=>settledServer.listen(0,'127.0.0.1',resolve));
    try {const denied=await fetch('http://127.0.0.1:'+settledServer.address().port+'/api/property-fees/41/collection-actions',{method:'POST',
      headers:{'content-type':'application/json','x-operation-reason':'Record owner collection follow-up','x-step-up-token':'step-up-token-123456789','idempotency-key':'property-collection-0002'},
      body:JSON.stringify({action_type:'phone',outcome:'reached',contacted_at:'2030-02-01'})});
      assert.equal(denied.status,409);assert.deepEqual(await denied.json(),{error:'PROPERTY_COLLECTION_BILL_SETTLED'});
    } finally {await new Promise(resolve=>settledServer.close(resolve));}
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('property collection follow-up queue returns latest due action and validates pagination', async () => {
  const calls=[];const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{calls.push({sql,params});
    if(sql.includes('COUNT(*)')) return [[{total_count:2}]];
    return [[{action_id:8,bill_id:41,action_type:'phone',outcome:'promised',contacted_at:'2030-02-01',
      follow_up_date:'2030-02-08',note:'Call back',room_id:4,room_no:'P-401',tenant_id:8,tenant_name:'Owner Ltd',
      outstanding_amount:'100.00',days_follow_up_overdue:2}]];
  }};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/collection-follow-ups?as_of=2030-02-10&page=2&page_size=10');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.total_count,2);assert.equal(body.items[0].bill_id,41);
    assert.equal(body.items[0].days_follow_up_overdue,2);assert.equal(body.items[0].tenant_name,'Owner Ltd');
    assert.match(calls[1].sql,/SELECT MAX\(latest.id\)/);
    assert.deepEqual(calls[1].params,['2030-02-10','2030-02-10',10,10]);
    const invalid=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/collection-follow-ups?as_of=2030-02-30');
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'PROPERTY_COLLECTION_DATE_INVALID'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('property collection history is restricted to a property bill and ordered newest first', async () => {
  const calls=[];const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{calls.push({sql,params});
    return sql.includes('SELECT id FROM bills')?[[{id:41}]]:[[{id:8,bill_id:41,action_type:'phone',outcome:'promised',
      contacted_at:'2030-02-01',follow_up_date:'2030-02-08',note:'Call back',created_at:'2030-02-01 10:00:00'}]];
  }};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/41/collection-actions');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.bill_id,41);assert.equal(body.items.length,1);assert.equal(body.items[0].follow_up_date,'2030-02-08');
    assert.match(calls[1].sql,/ORDER BY contacted_at DESC, id DESC LIMIT 100/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('property owner statements paginate details while preserving whole-period totals', async () => {
  const calls=[];
  const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('COUNT(DISTINCT b.tenant_id)')) return [[{
      owners_count:75,bills_count:140,billed_amount:'30000.00',current_paid_amount:'10000.00',
      outstanding_amount:'20000.00',period_receipts:'12000.00',period_refunds:'2000.00'
    }]];
    return [[{
      owner_id:9,owner_name:'Owner Co',bills_count:2,rooms_count:2,billed_amount:'300.00',
      current_paid_amount:'100.00',outstanding_amount:'200.00',period_receipts:'120.00',period_refunds:'20.00'
    }]];
  }};next();});
  app.use('/api',createPropertyFeeRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/owner-statements?from_date=2030-01-01&to_date=2030-01-31&page=2&page_size=25');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.items[0].owner_id,9);assert.equal(body.items[0].billed_amount,300);
    assert.equal(body.items[0].outstanding_amount,200);assert.equal(body.totals.period_receipts,12000);
    assert.equal(body.total_count,75);assert.equal(body.page,2);assert.equal(body.page_size,25);
    assert.deepEqual(calls[0].params,['2030-01-01','2030-01-31','2030-01-01','2030-01-31']);
    assert.deepEqual(calls[1].params,['2030-01-01','2030-01-31','2030-01-01','2030-01-31',25,25]);
    assert.match(calls[0].sql,/COUNT\(DISTINCT b\.tenant_id\)/);
    assert.match(calls[1].sql,/FROM bill_transactions WHERE transaction_date BETWEEN/);
    const invalid=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/owner-statements?from_date=2030-02-01&to_date=2030-01-01');
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'PROPERTY_OWNER_STATEMENT_RANGE_INVALID'});
    const invalidPage=await fetch('http://127.0.0.1:'+server.address().port+'/api/property-fees/owner-statements?from_date=2030-01-01&to_date=2030-01-31&page=1&page_size=101');
    assert.equal(invalidPage.status,400);assert.deepEqual(await invalidPage.json(),{error:'PROPERTY_OWNER_STATEMENT_PAGINATION_INVALID'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('hotel deposit transaction DTO rejects invalid and client-controlled fields', () => {
  const { validateHotelDepositTransaction } = require('../services/hotel-api/order-routes');
  assert.equal(validateHotelDepositTransaction({ amount: 12.5, pay_method: 'cash', transaction_date: '2030-01-31' }).amount, 12.5);
  for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 1.001 }, { amount: 5, held_amount: 99 }, { amount: 5, transaction_date: '2030-02-30' }]) {
    assert.throws(() => validateHotelDepositTransaction(bad), e => e.code === 'HOTEL_DEPOSIT_INPUT_INVALID');
  }
});
test('hotel deposit receipt and refund enforce expected and held balances transactionally', async () => {
  const { createHotelOrderRouter } = require('../services/hotel-api/order-routes');
  const app=express();app.use(express.json());
  const ledger=[];const calls=[];
  app.use((req,_res,next)=>{req.tenantWrite=async input=>{calls.push(input);return input.mutate({
    execute:async(sql,params)=>{
      if(sql.includes('FROM orders')) return [[{id:8,deposit:'30.00',status:'booked'}]];
      if(sql.includes('SUM(CASE WHEN transaction_type')) {
        const received=ledger.filter(x=>x.type==='receipt').reduce((n,x)=>n+x.amount,0);
        const refunded=ledger.filter(x=>x.type==='refund').reduce((n,x)=>n+x.amount,0);
        return [[{held_amount:received-refunded,received_amount:received,refunded_amount:refunded}]];
      }
      if(sql.includes('INSERT INTO hotel_order_deposit_transactions')) {ledger.push({type:sql.includes("'receipt'")?'receipt':'refund',amount:params[1]});return [{affectedRows:1}];}
      return [[]];
    }
  });};next();});
  app.use('/api',createHotelOrderRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const send=(path,body,key)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'content-type':'application/json','x-operation-reason':'Record hotel deposit','x-step-up-token':'step-up-token-123456789','idempotency-key':key},body:JSON.stringify(body)});
  try {
    const received=await send('/api/orders/8/deposit/receive',{amount:20},'hotel-deposit-receive-0001');
    assert.equal(received.status,201);assert.equal((await received.json()).held_amount,20);
    const refunded=await send('/api/orders/8/deposit/refund',{amount:5},'hotel-deposit-refund-0001');
    assert.equal(refunded.status,201);assert.equal((await refunded.json()).held_amount,15);
    const excess=await send('/api/orders/8/deposit/refund',{amount:16},'hotel-deposit-refund-0002');
    assert.equal(excess.status,409);assert.equal(calls.length,3);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('property fee job id validation rejects malformed identifiers',()=>{assert.equal(validatePropertyFeeJobId('12'),12);for(const value of ['0','-1','1.2','abc','9007199254740992'])assert.throws(()=>validatePropertyFeeJobId(value),e=>e.code==='PROPERTY_FEE_JOB_ID_INVALID');});

test('GET hotel deposit ledger paginates transaction history and retains full balance totals', async () => {
  const http=require('node:http');const express=require('express');const calls=[];const app=express();
  app.use((req,_res,next)=>{req.tenantDb={execute:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('SELECT id, deposit FROM orders'))return [[{id:8,deposit:'30.00'}]];
    if(sql.includes('SUM(CASE WHEN transaction_type'))return [[{held_amount:15,received_amount:20,refunded_amount:5}]];
    if(sql.includes('COUNT(*) AS total_count'))return [[{total_count:125}]];
    if(sql.includes('ORDER BY id DESC LIMIT'))return [[{id:76,transaction_type:'receipt',amount:'1.00'}]];
    throw new Error('UNEXPECTED_SQL');
  }};next();});
  app.use('/api',createHotelOrderRouter());app.use((e,_q,res,_n)=>res.status(e.status||500).json({error:e.code||'ERROR'}));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/orders/8/deposit?page=2&page_size=25');
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.page,2);assert.equal(body.page_size,25);assert.equal(body.total_count,125);
    assert.equal(body.held_amount,15);assert.equal(body.remaining_to_receive,10);assert.equal(body.transactions[0].id,76);
    assert.deepEqual(calls.find(x=>x.sql.includes('ORDER BY id DESC LIMIT')).params,[8,25,25]);
    const invalid=await fetch('http://127.0.0.1:'+server.address().port+'/api/orders/8/deposit?page=0');
    assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'HOTEL_DEPOSIT_PAGINATION_INVALID'});
  }finally{await new Promise(resolve=>server.close(resolve));}
});
