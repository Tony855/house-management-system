'use strict';

const express = require('express');
const { ALLOWED_FIELDS, validateRoom } = require('../rental-api/write-routes');
const { validateProductRoom } = require('./product-room-write-routes');

const FIELDS = Object.freeze({
  rental: ALLOWED_FIELDS,
  hotel: new Set(['building_id','room_no','floor','area','day_price','deposit','status','room_type','is_dorm','capacity','remark']),
  property: new Set(['building_id','room_no','floor','area','status','room_type','owner_id','property_fee','is_dorm','capacity','water_price','elec_price','remark'])
});
function fail(code, status) { return Object.assign(new Error(code), { code, status }); }
function validatePatch(appId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Object.keys(body).length || Object.keys(body).some(key => !FIELDS[appId].has(key))) {
    throw fail('ROOM_INPUT_INVALID', 400);
  }
}
function createRoomUpdateRouter(appId) {
  if (!FIELDS[appId]) throw new TypeError('ROOM_UPDATE_PRODUCT_INVALID');
  const router = express.Router();
  const updateRoom = async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw fail('ROOM_ID_INVALID', 400);
      validatePatch(appId, req.body);
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, patch: req.body },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT * FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw fail('ROOM_NOT_FOUND', 404);
          const current = Object.fromEntries(Object.entries(rows[0]).filter(([key]) => FIELDS[appId].has(key)));
          const merged = { ...current, ...req.body };
          const room = appId === 'rental' ? validateRoom(merged) : validateProductRoom(appId, merged);
          const [buildings] = await tx.execute('SELECT id FROM buildings WHERE id = ? LIMIT 1 FOR UPDATE', [room.building_id]);
          if (!buildings.length) throw fail('BUILDING_NOT_FOUND', 404);
          const [duplicates] = await tx.execute(
            'SELECT id FROM rooms WHERE building_id = ? AND room_no = ? AND id <> ? LIMIT 1 FOR UPDATE',
            [room.building_id, room.room_no, id]
          );
          if (duplicates.length) throw fail('ROOM_ALREADY_EXISTS', 409);
          if (appId === 'property' && room.owner_id !== null) {
            const [owners] = await tx.execute('SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE', [room.owner_id]);
            if (!owners.length) throw fail('ROOM_OWNER_NOT_FOUND', 404);
          }
          await tx.updateById('rooms', id, room);
          return { id, ...room };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  };
  router.put('/rooms/:id', updateRoom);
  router.patch('/rooms/:id', updateRoom);
  return router;
}
module.exports = { createRoomUpdateRouter, validatePatch };
