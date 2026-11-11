'use strict';

const express = require('express');

const CONFIG = Object.freeze({
  hotel: Object.freeze({
    fields: new Set(['building_id','room_no','floor','area','day_price','deposit','status','room_type','is_dorm','capacity','remark']),
    statuses: new Set(['vacant','rented','booked','cleaning','maintenance']),
    priceField: 'day_price'
  }),
  property: Object.freeze({
    fields: new Set(['building_id','room_no','floor','area','status','room_type','owner_id','property_fee','is_dorm','capacity','water_price','elec_price','remark']),
    statuses: new Set(['vacant','rented','maintenance'])
  })
});
function fail(code, status) { return Object.assign(new Error(code), { code, status }); }
function money(value, max = 100000000) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max || Math.round(n * 100) !== n * 100) throw fail('ROOM_INPUT_INVALID', 400);
  return n;
}
function validateProductRoom(appId, body) {
  const config = CONFIG[appId];
  if (!config || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !config.fields.has(key))) throw fail('ROOM_INPUT_INVALID', 400);
  const buildingId = Number(body.building_id);
  if (!Number.isSafeInteger(buildingId) || buildingId < 1 ||
      typeof body.room_no !== 'string' || !body.room_no.trim() || body.room_no.trim().length > 20) throw fail('ROOM_INPUT_INVALID', 400);
  const status = body.status === undefined ? 'vacant' : body.status;
  if (!config.statuses.has(status)) throw fail('ROOM_INPUT_INVALID', 400);
  const roomType = body.room_type === undefined ? '' : body.room_type;
  const remark = body.remark === undefined ? '' : body.remark;
  if (typeof roomType !== 'string' || roomType.length > 50 || typeof remark !== 'string' || remark.length > 200) throw fail('ROOM_INPUT_INVALID', 400);
  const dorm = body.is_dorm === undefined ? 0 : body.is_dorm;
  const capacity = body.capacity === undefined ? 0 : Number(body.capacity);
  if (![0,1,false,true].includes(dorm) || !Number.isSafeInteger(capacity) || capacity < 0 || capacity > 100000) throw fail('ROOM_INPUT_INVALID', 400);
  const room = {
    building_id: buildingId, room_no: body.room_no.trim(),
    floor: body.floor === undefined || body.floor === null || body.floor === '' ? null : Number(body.floor),
    area: body.area === undefined || body.area === null || body.area === '' ? null : money(body.area, 1000000),
    status, room_type: roomType, is_dorm: dorm === true ? 1 : Number(dorm), capacity, remark
  };
  if (room.floor !== null && (!Number.isFinite(room.floor) || room.floor < -1000 || room.floor > 10000 || Math.round(room.floor * 10) !== room.floor * 10)) throw fail('ROOM_INPUT_INVALID', 400);
  if (appId === 'hotel') {
    room.day_price = money(body.day_price);
    room.deposit = money(body.deposit);
  } else {
    const ownerId = body.owner_id === undefined || body.owner_id === null || body.owner_id === '' ? null : Number(body.owner_id);
    if (ownerId !== null && (!Number.isSafeInteger(ownerId) || ownerId < 1)) throw fail('ROOM_INPUT_INVALID', 400);
    room.owner_id = ownerId;
    room.property_fee = money(body.property_fee);
    room.water_price = money(body.water_price, 1000000);
    room.elec_price = money(body.elec_price, 1000000);
  }
  return Object.freeze(room);
}
function createProductRoomWriteRouter(appId) {
  if (!CONFIG[appId]) throw new TypeError('ROOM_WRITE_PRODUCT_INVALID');
  const router = express.Router();
  router.post('/rooms', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const room = validateProductRoom(appId, req.body);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: room,
        mutate: async tx => {
          const [buildings] = await tx.execute('SELECT id FROM buildings WHERE id = ? LIMIT 1 FOR UPDATE', [room.building_id]);
          if (!buildings.length) throw fail('BUILDING_NOT_FOUND', 404);
          const [existing] = await tx.execute('SELECT id FROM rooms WHERE building_id = ? AND room_no = ? LIMIT 1 FOR UPDATE', [room.building_id, room.room_no]);
          if (existing.length) throw fail('ROOM_ALREADY_EXISTS', 409);
          if (appId === 'property' && room.owner_id !== null) {
            const [owners] = await tx.execute('SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE', [room.owner_id]);
            if (!owners.length) throw fail('ROOM_OWNER_NOT_FOUND', 404);
          }
          const inserted = await tx.insert('rooms', room);
          return { id: Number(inserted.insertId), ...room };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { validateProductRoom, createProductRoomWriteRouter };
