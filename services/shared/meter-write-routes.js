'use strict';

const express = require('express');
const { parseMinorUnits } = require('../../server/money');
function meterError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validateMeter(input) {
  const allowed = new Set(['room_id','month','water_prev','water_curr','elec_prev','elec_curr','remark']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) throw meterError('METER_INPUT_INVALID');
  const room_id = Number(input.room_id), month = input.month;
  const money = value => {
    const minor = parseMinorUnits(value === undefined ? 0 : value, { allowZero: true, maxMinor: 10000000000 });
    if (minor === null) throw meterError('METER_INPUT_INVALID');
    return minor / 100;
  };
  const water_prev = money(input.water_prev), water_curr = money(input.water_curr);
  const elec_prev = money(input.elec_prev), elec_curr = money(input.elec_curr);
  if (!Number.isSafeInteger(room_id) || room_id < 1 || typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      water_curr < water_prev || elec_curr < elec_prev || typeof (input.remark || '') !== 'string' || (input.remark || '').length > 200) throw meterError('METER_INPUT_INVALID');
  return Object.freeze({ room_id, month, water_prev, water_curr, elec_prev, elec_curr, remark: input.remark || '' });
}
function createMeterWriteRouter(appId) {
  if (!['rental','property'].includes(appId)) throw new TypeError('METER_APP_INVALID');
  const router = express.Router();
  router.post('/meters', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const meter = validateMeter(req.body);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId: req.get('idempotency-key'), payload: { ...meter, __resource: 'meters' },
        mutate: async tx => {
          const [rooms] = await tx.execute('SELECT id, water_price, elec_price FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [meter.room_id]);
          if (!rooms.length) throw meterError('ROOM_NOT_FOUND', 404);
          const room = rooms[0];
          const [existing] = await tx.execute('SELECT id FROM meters WHERE room_id = ? AND month = ? LIMIT 1 FOR UPDATE', [meter.room_id, meter.month]);
          if (existing.length) throw meterError('METER_ALREADY_EXISTS', 409);
          const [previous] = await tx.execute('SELECT month, water_curr, elec_curr FROM meters WHERE room_id = ? AND month < ? ORDER BY month DESC LIMIT 1 FOR UPDATE', [meter.room_id, meter.month]);
          if (previous.length && (Number(previous[0].water_curr) !== meter.water_prev || Number(previous[0].elec_curr) !== meter.elec_prev)) {
            throw meterError('METER_PREVIOUS_READING_MISMATCH', 409);
          }
          const water_usage = meter.water_curr - meter.water_prev;
          const elec_usage = meter.elec_curr - meter.elec_prev;
          const water_price = Number(room.water_price), elec_price = Number(room.elec_price);
          if (!Number.isFinite(water_price) || water_price < 0 || !Number.isFinite(elec_price) || elec_price < 0) throw meterError('METER_RATE_INVALID', 409);
          const water_fee = Math.round(water_usage * water_price * 100) / 100;
          const elec_fee = Math.round(elec_usage * elec_price * 100) / 100;
          const record = { ...meter, water_usage, water_fee, elec_usage, elec_fee };
          const inserted = await tx.insert('meters', record);
          return { id: Number(inserted.insertId), ...record };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { validateMeter, createMeterWriteRouter };
