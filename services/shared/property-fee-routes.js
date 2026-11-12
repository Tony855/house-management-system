'use strict';

const express = require('express');

function propertyFeeError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function validatePropertyFeeGeneration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'month') ||
      typeof input.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
    throw propertyFeeError('PROPERTY_FEE_INPUT_INVALID');
  }
  return Object.freeze({ month: input.month });
}

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function monthDates(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = month + '-01';
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start, end, due: month + '-10' };
}

const COLLECTION_ACTIONS = new Set(['phone', 'sms', 'email', 'onsite', 'formal_notice']);
const COLLECTION_OUTCOMES = new Set(['reached', 'no_answer', 'promised', 'disputed', 'refused', 'sent']);
function validDate(value) {
  return typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function validatePropertyCollectionAction(input) {
  const allowed = new Set(['action_type', 'outcome', 'contacted_at', 'follow_up_date', 'note']);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.has(key))) {
    throw propertyFeeError('PROPERTY_COLLECTION_INPUT_INVALID');
  }
  const action_type = input.action_type;
  const outcome = input.outcome;
  const contacted_at = input.contacted_at === undefined ? new Date().toISOString().slice(0, 10) : input.contacted_at;
  const follow_up_date = input.follow_up_date === undefined || input.follow_up_date === null ? null : input.follow_up_date;
  const note = input.note === undefined ? '' : input.note;
  if (!COLLECTION_ACTIONS.has(action_type) || !COLLECTION_OUTCOMES.has(outcome) ||
      !validDate(contacted_at) || (follow_up_date !== null && (!validDate(follow_up_date) || follow_up_date < contacted_at)) ||
      (outcome === 'promised' && follow_up_date === null) ||
      typeof note !== 'string' || note.trim().length > 500) {
    throw propertyFeeError('PROPERTY_COLLECTION_INPUT_INVALID');
  }
  return Object.freeze({ action_type, outcome, contacted_at, follow_up_date, note: note.trim() });
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
  router.post('/property-fees/:billId/collection-actions', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const billId = Number(req.params.billId);
      if (!Number.isSafeInteger(billId) || billId < 1) throw propertyFeeError('PROPERTY_COLLECTION_BILL_ID_INVALID');
      const action = validatePropertyCollectionAction(req.body);
      const requestId = req.get('idempotency-key');
      const result = await req.tenantWrite({
        operation: 'create',
        reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'),
        requestId,
        payload: { bill_id: billId, ...action, __resource: 'property-collection-actions' },
        mutate: async tx => {
          const [rows] = await tx.execute(
            "SELECT id, source, due_date, amount, paid_amount FROM bills WHERE id = ? LIMIT 1 FOR UPDATE",
            [billId]
          );
          if (!rows.length || rows[0].source !== 'property') throw propertyFeeError('PROPERTY_COLLECTION_BILL_NOT_FOUND', 404);
          const bill = rows[0];
          if (dateOnly(bill.due_date) >= action.contacted_at) throw propertyFeeError('PROPERTY_COLLECTION_BILL_NOT_OVERDUE', 409);
          if (Number(bill.amount) <= Number(bill.paid_amount)) throw propertyFeeError('PROPERTY_COLLECTION_BILL_SETTLED', 409);
          const [inserted] = await tx.execute(
            'INSERT INTO property_collection_actions (bill_id, action_type, outcome, contacted_at, follow_up_date, note, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [billId, action.action_type, action.outcome, action.contacted_at, action.follow_up_date, action.note, requestId]
          );
          return { id: Number(inserted.insertId), bill_id: billId, ...action };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.get('/property-fees/collection-follow-ups', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') {
        return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      }
      const asOf = req.query.as_of === undefined ? new Date().toISOString().slice(0, 10) : req.query.as_of;
      if (!validDate(asOf)) throw propertyFeeError('PROPERTY_COLLECTION_DATE_INVALID');
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const pageSize = req.query.page_size === undefined ? 50 : Number(req.query.page_size);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw propertyFeeError('PROPERTY_COLLECTION_PAGINATION_INVALID');
      }
      const offset = (page - 1) * pageSize;
      const filter = `b.source = 'property' AND b.amount > b.paid_amount
        AND a.follow_up_date IS NOT NULL AND a.follow_up_date <= ?
        AND a.id = (SELECT MAX(latest.id) FROM property_collection_actions latest WHERE latest.bill_id = a.bill_id)`;
      const [countRows] = await req.tenantDb.execute(
        `SELECT COUNT(*) AS total_count FROM property_collection_actions a
           INNER JOIN bills b ON b.id = a.bill_id WHERE ${filter}`, [asOf]
      );
      const [rows] = await req.tenantDb.execute(
        `SELECT a.id AS action_id, a.bill_id, a.action_type, a.outcome, a.contacted_at,
                a.follow_up_date, a.note, b.room_id, r.room_no, b.tenant_id,
                t.name AS tenant_name, ROUND(b.amount - b.paid_amount, 2) AS outstanding_amount,
                DATEDIFF(?, a.follow_up_date) AS days_follow_up_overdue
           FROM property_collection_actions a
           INNER JOIN bills b ON b.id = a.bill_id
           INNER JOIN rooms r ON r.id = b.room_id
           LEFT JOIN tenants t ON t.id = b.tenant_id
          WHERE ${filter}
          ORDER BY a.follow_up_date ASC, a.id ASC LIMIT ? OFFSET ?`,
        [asOf, asOf, pageSize, offset]
      );
      return res.json({
        as_of: asOf, page, page_size: pageSize,
        total_count: Number(countRows[0]?.total_count || 0),
        items: rows.map(row => ({
          action_id: Number(row.action_id), bill_id: Number(row.bill_id), action_type: row.action_type,
          outcome: row.outcome, contacted_at: dateOnly(row.contacted_at),
          follow_up_date: dateOnly(row.follow_up_date), note: row.note || '',
          room_id: Number(row.room_id), room_no: row.room_no,
          tenant_id: row.tenant_id === null ? null : Number(row.tenant_id),
          tenant_name: row.tenant_name || '', outstanding_amount: Number(row.outstanding_amount),
          days_follow_up_overdue: Number(row.days_follow_up_overdue)
        }))
      });
    } catch (error) { return next(error); }
  });
  router.get('/property-fees/:billId/collection-actions', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') {
        return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      }
      const billId = Number(req.params.billId);
      if (!Number.isSafeInteger(billId) || billId < 1) throw propertyFeeError('PROPERTY_COLLECTION_BILL_ID_INVALID');
      const [billRows] = await req.tenantDb.execute(
        "SELECT id FROM bills WHERE id = ? AND source = 'property' LIMIT 1", [billId]
      );
      if (!billRows.length) throw propertyFeeError('PROPERTY_COLLECTION_BILL_NOT_FOUND', 404);
      const [rows] = await req.tenantDb.execute(
        'SELECT id, bill_id, action_type, outcome, contacted_at, follow_up_date, note, created_at FROM property_collection_actions WHERE bill_id = ? ORDER BY contacted_at DESC, id DESC LIMIT 100',
        [billId]
      );
      return res.json({ bill_id: billId, items: rows.map(row => ({
        id: Number(row.id), bill_id: Number(row.bill_id), action_type: row.action_type, outcome: row.outcome,
        contacted_at: dateOnly(row.contacted_at), follow_up_date: row.follow_up_date ? dateOnly(row.follow_up_date) : null,
        note: row.note || '', created_at: row.created_at
      })) });
    } catch (error) { return next(error); }
  });
  router.get('/property-fees/arrears', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') {
        return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      }
      const asOf = req.query.as_of === undefined ? new Date().toISOString().slice(0, 10) : req.query.as_of;
      if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
          !Number.isFinite(Date.parse(asOf + 'T00:00:00Z')) ||
          new Date(asOf + 'T00:00:00Z').toISOString().slice(0, 10) !== asOf) {
        throw propertyFeeError('PROPERTY_ARREARS_DATE_INVALID');
      }
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const pageSize = req.query.page_size === undefined ? 50 : Number(req.query.page_size);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw propertyFeeError('PROPERTY_ARREARS_PAGINATION_INVALID');
      }
      const offset = (page - 1) * pageSize;
      const filter = "b.source = 'property' AND b.due_date < ? AND b.amount > b.paid_amount";
      const [countRows] = await req.tenantDb.execute(
        `SELECT COUNT(*) AS total_count FROM bills b WHERE ${filter}`, [asOf]
      );
      const [summaryRows] = await req.tenantDb.execute(
        `SELECT COUNT(*) AS overdue_count,
                COALESCE(SUM(b.amount - b.paid_amount), 0) AS total_outstanding,
                COALESCE(SUM(CASE WHEN DATEDIFF(?, b.due_date) BETWEEN 1 AND 30 THEN b.amount - b.paid_amount ELSE 0 END), 0) AS days_1_30,
                COALESCE(SUM(CASE WHEN DATEDIFF(?, b.due_date) BETWEEN 31 AND 60 THEN b.amount - b.paid_amount ELSE 0 END), 0) AS days_31_60,
                COALESCE(SUM(CASE WHEN DATEDIFF(?, b.due_date) BETWEEN 61 AND 90 THEN b.amount - b.paid_amount ELSE 0 END), 0) AS days_61_90,
                COALESCE(SUM(CASE WHEN DATEDIFF(?, b.due_date) > 90 THEN b.amount - b.paid_amount ELSE 0 END), 0) AS days_over_90
           FROM bills b WHERE ${filter}`,
        [asOf, asOf, asOf, asOf, asOf]
      );
      const [rows] = await req.tenantDb.execute(
        `SELECT b.id, b.source, b.room_id, r.room_no, r.owner_id,
                b.tenant_id, t.name AS tenant_name, b.due_date, b.amount, b.paid_amount,
                ROUND(b.amount - b.paid_amount, 2) AS outstanding_amount,
                DATEDIFF(?, b.due_date) AS days_overdue
           FROM bills b
           INNER JOIN rooms r ON r.id = b.room_id
           LEFT JOIN tenants t ON t.id = b.tenant_id
          WHERE ${filter}
          ORDER BY b.due_date ASC, b.id ASC
          LIMIT ? OFFSET ?`,
        [asOf, asOf, pageSize, offset]
      );
      const items = rows.map(row => ({
        id: Number(row.id), source: row.source, room_id: Number(row.room_id),
        room_no: row.room_no, owner_id: row.owner_id === null ? null : Number(row.owner_id),
        tenant_id: row.tenant_id === null ? null : Number(row.tenant_id),
        tenant_name: row.tenant_name || '', due_date: dateOnly(row.due_date),
        amount: Number(row.amount), paid_amount: Number(row.paid_amount),
        outstanding_amount: Number(row.outstanding_amount), days_overdue: Number(row.days_overdue)
      }));
      const summary = summaryRows[0] || {};
      return res.json({
        as_of: asOf, page, page_size: pageSize,
        total_count: Number(countRows[0]?.total_count || 0),
        overdue_count: Number(summary.overdue_count || 0),
        total_outstanding: Number(summary.total_outstanding || 0),
        aging: {
          days_1_30: Number(summary.days_1_30 || 0),
          days_31_60: Number(summary.days_31_60 || 0),
          days_61_90: Number(summary.days_61_90 || 0),
          days_over_90: Number(summary.days_over_90 || 0)
        },
        items
      });
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { validatePropertyFeeGeneration, validatePropertyCollectionAction, monthDates, createPropertyFeeRouter };
