'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {buildPropertyFeeBill,monthDates}=require('../services/shared/property-fee-routes');
const room={room_id:12,owner_id:4,property_fee:'100.10',water_fee:'20.20',elec_fee:'30.30'};
test('property fee domain builds the canonical monthly bill with rounded amounts and dates',()=>{
 const bill=buildPropertyFeeBill(room,'2030-02');
 assert.deepEqual(bill,{source:'property',room_id:12,tenant_id:4,period_start:'2030-02-01',period_end:'2030-02-28',due_date:'2030-02-10',amount:150.6,paid_amount:0,status:'unpaid',remark:'明细：物业费 100.10 + 水费 20.20 + 电费 30.30'});
 assert.deepEqual(monthDates('2030-02'),{start:'2030-02-01',end:'2030-02-28',due:'2030-02-10'});
});
test('property fee domain skips zero totals and rejects negative or non-finite fee inputs',()=>{
 assert.equal(buildPropertyFeeBill({...room,property_fee:0,water_fee:0,elec_fee:0},'2030-02'),null);
 assert.throws(()=>buildPropertyFeeBill({...room,water_fee:-1},'2030-02'),e=>e.code==='PROPERTY_FEE_AMOUNT_INVALID');
 assert.throws(()=>buildPropertyFeeBill({...room,water_fee:'invalid'},'2030-02'),e=>e.code==='PROPERTY_FEE_AMOUNT_INVALID');
});
test('property fee domain requires a valid owner-bound room',()=>{
 assert.throws(()=>buildPropertyFeeBill({...room,owner_id:null},'2030-02'),e=>e.code==='PROPERTY_FEE_ROOM_OWNER_INVALID');
 assert.throws(()=>buildPropertyFeeBill(room,'2030-13'),e=>e.code==='PROPERTY_FEE_INPUT_INVALID');
});
