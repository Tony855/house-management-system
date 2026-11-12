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


const CONTRACT_FIELDS = new Set(['contract_no', 'room_id', 'tenant_id', 'start_date', 'end_date', 'rent', 'deposit', 'pay_cycle', 'sign_date', 'remark']);
function contractError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validateContract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !CONTRACT_FIELDS.has(key))) throw contractError('CONTRACT_INPUT_INVALID');
  const room_id = Number(input.room_id), tenant_id = Number(input.tenant_id);
  const pay_cycle = Number(input.pay_cycle === undefined ? 1 : input.pay_cycle);
  if (!Number.isSafeInteger(room_id) || room_id < 1 || !Number.isSafeInteger(tenant_id) || tenant_id < 1 ||
      !Number.isSafeInteger(pay_cycle) || pay_cycle < 1 || pay_cycle > 12 ||
      typeof input.contract_no !== 'string' || !input.contract_no.trim() || input.contract_no.trim().length > 50 ||
      !validDate(input.start_date) || !validDate(input.end_date) || input.end_date < input.start_date || !validDate(input.sign_date) ||
      typeof (input.remark || '') !== 'string' || (input.remark || '').length > 200) throw contractError('CONTRACT_INPUT_INVALID');
  const money = value => { const n = Number(value === undefined ? 0 : value); if (!Number.isFinite(n) || n < 0 || n > 100000000 || Math.round(n * 100) !== n * 100) throw contractError('CONTRACT_INPUT_INVALID'); return n; };
  return Object.freeze({ contract_no: input.contract_no.trim(), room_id, tenant_id, start_date: input.start_date, end_date: input.end_date,
    rent: money(input.rent), deposit: money(input.deposit), pay_cycle, sign_date: input.sign_date, remark: input.remark || '' });
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
        payload: { ...room, __resource: 'rooms' },
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

  router.post('/contracts', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const contract = validateContract(req.body);
      const result = await req.tenantWrite({ operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { ...contract, __resource: 'contracts' },
        mutate: async tx => {
          const [rooms] = await tx.execute('SELECT id, status FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [contract.room_id]);
          if (!rooms.length) throw contractError('ROOM_NOT_FOUND', 404);
          if (rooms[0].status !== 'vacant') throw contractError('ROOM_NOT_VACANT', 409);
          const [tenants] = await tx.execute('SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE', [contract.tenant_id]);
          if (!tenants.length) throw contractError('TENANT_NOT_FOUND', 404);
          const [active] = await tx.execute("SELECT id FROM contracts WHERE room_id = ? AND status = 'active' LIMIT 1 FOR UPDATE", [contract.room_id]);
          if (active.length) throw contractError('ROOM_HAS_ACTIVE_CONTRACT', 409);
          const inserted = await tx.insert('contracts', contract);
          await tx.updateById('rooms', contract.room_id, { status: 'rented' });
          return { id: Number(inserted.insertId), ...contract, status: 'active' };
        } });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.patch('/contracts/:id', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1 || !req.body || Object.keys(req.body).length !== 1 || !['expired', 'terminated'].includes(req.body.status)) throw contractError('CONTRACT_INPUT_INVALID');
      const status = req.body.status;
      const result = await req.tenantWrite({ operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, status, __resource: 'contracts' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, room_id, status FROM contracts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
          if (rows[0].status !== 'active') throw contractError('CONTRACT_STATUS_TRANSITION_INVALID', 409);
          await tx.updateById('contracts', id, { status });
          const [other] = await tx.execute("SELECT id FROM contracts WHERE room_id = ? AND status = 'active' AND id <> ? LIMIT 1 FOR UPDATE", [rows[0].room_id, id]);
          if (!other.length) await tx.updateById('rooms', rows[0].room_id, { status: 'vacant' });
          return { id, status };
        } });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { ALLOWED_FIELDS, validateRoom, validateContract, createRentalWriteRouter };
