'use strict';

const express = require('express');

const ALLOWED_FIELDS = new Set([
  'building_id', 'room_no', 'floor', 'area', 'rent', 'deposit', 'status',
  'room_type', 'is_dorm', 'capacity', 'water_price', 'elec_price', 'remark'
]);
const STATUSES = new Set(['vacant', 'rented', 'maintenance']);

function invalid() {
  return Object.assign(new Error('ROOM_INPUT_INVALID'), { code: 'ROOM_INPUT_INVALID', status: 400 });
}
function decimal(value, { min = 0, max, nullable = false } = {}) {
  if (value === undefined || value === null || value === '') return nullable ? null : 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max) || Math.round(n * 100) !== n * 100) throw invalid();
  return n;
}
function validateRoom(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const keys = Object.keys(body);
  if (keys.some(key => !ALLOWED_FIELDS.has(key))) throw invalid();
  const buildingId = Number(body.building_id);
  if (!Number.isSafeInteger(buildingId) || buildingId < 1) throw invalid();
  if (typeof body.room_no !== 'string' || !body.room_no.trim() || body.room_no.trim().length > 20) throw invalid();
  const status = body.status === undefined ? 'vacant' : body.status;
  if (!STATUSES.has(status)) throw invalid();
  const roomType = body.room_type === undefined ? '' : body.room_type;
  const remark = body.remark === undefined ? '' : body.remark;
  if (typeof roomType !== 'string' || roomType.length > 50 || typeof remark !== 'string' || remark.length > 200) throw invalid();
  const isDorm = body.is_dorm === undefined ? 0 : body.is_dorm;
  if (![0, 1, false, true].includes(isDorm)) throw invalid();
  const capacity = body.capacity === undefined ? 0 : Number(body.capacity);
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 100000) throw invalid();
  return Object.freeze({
    building_id: buildingId,
    room_no: body.room_no.trim(),
    floor: decimal(body.floor, { min: -1000, max: 10000, nullable: true }),
    area: decimal(body.area, { max: 1000000, nullable: true }),
    rent: decimal(body.rent, { max: 100000000 }),
    deposit: decimal(body.deposit, { max: 100000000 }),
    status,
    room_type: roomType,
    is_dorm: isDorm === true ? 1 : Number(isDorm),
    capacity,
    water_price: decimal(body.water_price, { max: 1000000 }),
    elec_price: decimal(body.elec_price, { max: 1000000 }),
    remark
  });
}

function createRentalWriteRouter() {
  const router = express.Router();
  router.post('/rooms', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') {
        return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      }
      const room = validateRoom(req.body);
      const reason = req.get('x-operation-reason');
      const stepUpToken = req.get('x-step-up-token');
      const requestId = req.get('idempotency-key');
      const result = await req.tenantWrite({
        operation: 'create',
        reason,
        stepUpToken,
        requestId,
        payload: room,
        mutate: async tx => {
          // Lock the parent building before checking duplicates. This serializes
          // room creation for the same building even before a unique index exists.
          const [buildings] = await tx.execute(
            'SELECT id FROM buildings WHERE id = ? LIMIT 1 FOR UPDATE', [room.building_id]
          );
          if (!buildings.length) {
            throw Object.assign(new Error('BUILDING_NOT_FOUND'), { code: 'BUILDING_NOT_FOUND', status: 404 });
          }
          const [existing] = await tx.execute(
            'SELECT id FROM rooms WHERE building_id = ? AND room_no = ? LIMIT 1 FOR UPDATE',
            [room.building_id, room.room_no]
          );
          if (existing.length) {
            throw Object.assign(new Error('ROOM_ALREADY_EXISTS'), { code: 'ROOM_ALREADY_EXISTS', status: 409 });
          }
          const inserted = await tx.insert('rooms', room);
          return { id: Number(inserted.insertId), ...room };
        }
      });
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = { ALLOWED_FIELDS, validateRoom, createRentalWriteRouter };
