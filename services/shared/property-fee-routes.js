'use strict';

const express = require('express');

function propertyFeeError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function validatePropertyFeeGeneration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'month') ||
      typeof input.month !== 'string' || !/^\\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
    throw propertyFeeError('PROPERTY_FEE_INPUT_INVALID');
  }
  return Object.freeze({ month: input.month });
}

function monthDates(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = month + '-01';
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start, end, due: month + '-10' };
}

function createPropertyFeeRouter() {
  const router = express.Router();
  router.post('/property-fees/generate', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') {
        return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      }
      const { month } = validatePropertyFeeGeneration(req.body);
      const dates = monthDates(month);
      const result = await req.tenantWrite({
        operation: 'create',
        reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'),
        requestId: req.get('idempotency-key'),
        payload: { month, __resource: 'property-bills' },
        mutate: async tx => {
          // Lock the complete owner-bound room set in a stable order. Concurrent
          // generation requests therefore cannot race past the duplicate check.
          const [rooms] = await tx.execute(
            `SELECT r.id AS room_id, r.owner_id, r.room_no, r.property_fee,
                    COALESCE(m.water_fee, 0) AS water_fee,
                    COALESCE(m.elec_fee, 0) AS elec_fee
               FROM rooms r
               LEFT JOIN meters m ON m.room_id = r.id AND m.month = ?
              WHERE r.owner_id IS NOT NULL
              ORDER BY r.id
              FOR UPDATE`,
            [month]
          );
          const bills = [];
          let skipped = 0;
          for (const room of rooms) {
            const propertyFee = Number(room.property_fee);
            const waterFee = Number(room.water_fee);
            const elecFee = Number(room.elec_fee);
            if (![propertyFee, waterFee, elecFee].every(value => Number.isFinite(value) && value >= 0)) {
              throw propertyFeeError('PROPERTY_FEE_AMOUNT_INVALID', 409);
            }
            const amount = Math.round((propertyFee + waterFee + elecFee) * 100) / 100;
            if (amount <= 0) {
              skipped++;
              continue;
            }
            const [existing] = await tx.execute(
              "SELECT id FROM bills WHERE source = 'property' AND room_id = ? AND period_start = ? LIMIT 1 FOR UPDATE",
              [room.room_id, dates.start]
            );
            if (existing.length) {
              skipped++;
              continue;
            }
            const detail = [
              propertyFee > 0 ? '物业费 ' + propertyFee.toFixed(2) : '',
              waterFee > 0 ? '水费 ' + waterFee.toFixed(2) : '',
              elecFee > 0 ? '电费 ' + elecFee.toFixed(2) : ''
            ].filter(Boolean).join(' + ');
            const bill = {
              source: 'property',
              room_id: Number(room.room_id),
              tenant_id: Number(room.owner_id),
              period_start: dates.start,
              period_end: dates.end,
              due_date: dates.due,
              amount,
              paid_amount: 0,
              status: 'unpaid',
              remark: '明细：' + detail
            };
            const inserted = await tx.insert('bills', bill);
            bills.push({ id: Number(inserted.insertId), ...bill });
          }
          return { month, generated: bills.length, skipped, bills };
        }
      });
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = { validatePropertyFeeGeneration, monthDates, createPropertyFeeRouter };
