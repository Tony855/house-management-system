'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateProductRoom } = require('../services/shared/product-room-write-routes');
const { validateHotelOrder, createHotelOrderRouter } = require('../services/hotel-api/order-routes');
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
