'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateProductRoom } = require('../services/shared/product-room-write-routes');

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
