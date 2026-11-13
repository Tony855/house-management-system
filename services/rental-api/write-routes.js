'use strict';

const express = require('express');
const { parseMinorUnits } = require('../../server/money');

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
  const maxMagnitude = Number.isFinite(max) ? Math.ceil(Math.max(Math.abs(min), Math.abs(max)) * 100) : Number.MAX_SAFE_INTEGER;
  const minor = parseMinorUnits(value, { allowZero: true, allowNegative: min < 0, maxMinor: maxMagnitude });
  const n = minor === null ? NaN : minor / 100;
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) throw invalid();
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
      !Number.isSafeInteger(pay_cycle) || pay_cycle < 1 || pay_cycle > 36 ||
      typeof input.contract_no !== 'string' || !input.contract_no.trim() || input.contract_no.trim().length > 50 ||
      !validDate(input.start_date) || !validDate(input.end_date) || input.end_date < input.start_date || !validDate(input.sign_date) ||
      typeof (input.remark || '') !== 'string' || (input.remark || '').length > 200) throw contractError('CONTRACT_INPUT_INVALID');
  const money = value => {
    const minor = parseMinorUnits(value === undefined ? 0 : value, { allowZero: true, maxMinor: 10000000000 });
    if (minor === null) throw contractError('CONTRACT_INPUT_INVALID');
    return minor / 100;
  };
  return Object.freeze({ contract_no: input.contract_no.trim(), room_id, tenant_id, start_date: input.start_date, end_date: input.end_date,
    rent: money(input.rent), deposit: money(input.deposit), pay_cycle, sign_date: input.sign_date, remark: input.remark || '' });
}


const RENEWAL_FIELDS = new Set(['end_date', 'rent', 'deposit', 'pay_cycle', 'remark']);
function validateContractRenewal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length === 0 || Object.keys(input).some(key => !RENEWAL_FIELDS.has(key)) ||
      !validDate(input.end_date)) throw contractError('CONTRACT_RENEWAL_INPUT_INVALID');
  const result = { end_date: input.end_date };
  for (const field of ['rent', 'deposit']) {
    if (input[field] !== undefined) {
      const minor = parseMinorUnits(input[field], { allowZero: true, maxMinor: 10000000000 });
      if (minor === null) throw contractError('CONTRACT_RENEWAL_INPUT_INVALID');
      result[field] = minor / 100;
    }
  }
  if (input.pay_cycle !== undefined) {
    const cycle = Number(input.pay_cycle);
    if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > 36) throw contractError('CONTRACT_RENEWAL_INPUT_INVALID');
    result.pay_cycle = cycle;
  }
  if (input.remark !== undefined) {
    if (typeof input.remark !== 'string' || input.remark.length > 200) throw contractError('CONTRACT_RENEWAL_INPUT_INVALID');
    result.remark = input.remark;
  }
  return Object.freeze(result);
}

function addCalendarMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
  return result.toISOString().slice(0, 10);
}
function addCalendarDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function buildNextRentalBill(contract, lastPeriodEnd, today) {
  if (!contract || !validDate(contract.start_date) || !validDate(contract.end_date) ||
      !validDate(today) || (lastPeriodEnd && !validDate(lastPeriodEnd))) throw contractError('RENTAL_BILL_CONTEXT_INVALID');
  if (contract.status !== 'active') throw contractError('CONTRACT_NOT_ACTIVE', 409);
  const cycle = Number(contract.pay_cycle) || 1;
  const rentMinor = parseMinorUnits(contract.rent, { allowZero: true, maxMinor: 10000000000 });
  if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > 36 || rentMinor === null) throw contractError('RENTAL_BILL_CONTEXT_INVALID');
  const periodStart = lastPeriodEnd ? addCalendarDays(lastPeriodEnd, 1) : contract.start_date;
  if (periodStart > today) throw contractError('RENTAL_BILL_NOT_DUE', 409);
  if (periodStart > contract.end_date) throw contractError('CONTRACT_PERIOD_FINISHED', 409);
  const calculatedEnd = addCalendarDays(addCalendarMonths(periodStart, cycle), -1);
  const periodEnd = calculatedEnd > contract.end_date ? contract.end_date : calculatedEnd;
  return Object.freeze({
    source: 'rental', room_id: Number(contract.room_id), tenant_id: Number(contract.tenant_id),
    contract_id: Number(contract.id), period_start: periodStart, period_end: periodEnd,
    due_date: periodStart, amount: (rentMinor * cycle) / 100,
    paid_amount: 0, status: 'unpaid', remark: '合同 ' + contract.contract_no
  });
}

const RENTAL_BILL_JOB_CHUNK_SIZE = 50;
function validateRentalBillJobId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw contractError('RENTAL_BILL_JOB_ID_INVALID');
  return id;
}
function rentalDateOnly(value) { return value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10); }
function mapRentalBillJob(row) {
  return { id:Number(row.id), as_of:rentalDateOnly(row.as_of_date), state:row.state,
    cursor_contract_id:Number(row.cursor_contract_id||0), generated:Number(row.generated_count||0),
    skipped:Number(row.skipped_count||0), created_at:row.created_at, updated_at:row.updated_at,
    completed_at:row.completed_at||null };
}
const RENTAL_DEPOSIT_FIELDS = new Set(['amount', 'pay_method', 'transaction_date', 'external_reference', 'note']);
function validateRentalDepositTransaction(input, action) {
  if (!['receipt', 'refund', 'deduction'].includes(action) || !input || typeof input !== 'object' ||
      Array.isArray(input) || Object.keys(input).some(key => !RENTAL_DEPOSIT_FIELDS.has(key))) {
    throw contractError('RENTAL_DEPOSIT_INPUT_INVALID');
  }
  const amountMinor = parseMinorUnits(input.amount);
  const amount = amountMinor === null ? NaN : amountMinor / 100;
  const pay_method = input.pay_method === undefined ? '' : input.pay_method;
  const transaction_date = input.transaction_date === undefined ? new Date().toISOString().slice(0, 10) : input.transaction_date;
  const external_reference = input.external_reference === undefined ? '' : input.external_reference;
  const note = input.note === undefined ? '' : input.note;
  if (!Number.isFinite(amount) ||
      typeof pay_method !== 'string' || pay_method.length > 30 || !validDate(transaction_date) ||
      typeof external_reference !== 'string' || external_reference.length > 100 ||
      typeof note !== 'string' || note.trim().length > 500 ||
      (action === 'deduction' && !note.trim()) ||
      (action !== 'deduction' && !pay_method.trim())) throw contractError('RENTAL_DEPOSIT_INPUT_INVALID');
  return Object.freeze({ amount, pay_method: pay_method.trim(), transaction_date, external_reference: external_reference.trim(), note: note.trim() });
}
async function readRentalDepositBalance(tx, contractId) {
  const [rows] = await tx.execute(
    "SELECT COALESCE(SUM(CASE WHEN transaction_type = 'receipt' THEN amount ELSE 0 END), 0) AS received_amount, COALESCE(SUM(CASE WHEN transaction_type = 'refund' THEN amount ELSE 0 END), 0) AS refunded_amount, COALESCE(SUM(CASE WHEN transaction_type = 'deduction' THEN amount ELSE 0 END), 0) AS deducted_amount FROM rental_contract_deposit_transactions WHERE contract_id = ?",
    [contractId]
  );
  const receivedMinor = parseMinorUnits(rows[0].received_amount || 0, { allowZero: true, maxMinor: 10000000000 });
  const refundedMinor = parseMinorUnits(rows[0].refunded_amount || 0, { allowZero: true, maxMinor: 10000000000 });
  const deductedMinor = parseMinorUnits(rows[0].deducted_amount || 0, { allowZero: true, maxMinor: 10000000000 });
  if ([receivedMinor, refundedMinor, deductedMinor].some(value => value === null) ||
      refundedMinor + deductedMinor > receivedMinor) {
    throw contractError('RENTAL_DEPOSIT_BALANCE_INVALID', 409);
  }
  return { received_amount: receivedMinor / 100, refunded_amount: refundedMinor / 100,
    deducted_amount: deductedMinor / 100, held_amount: (receivedMinor - refundedMinor - deductedMinor) / 100 };
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
  router.post('/contracts/:id/generate-bill', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1 || (req.body && Object.keys(req.body).length)) throw contractError('RENTAL_BILL_INPUT_INVALID');
      const today = new Date().toISOString().slice(0, 10);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { contract_id: id, __resource: 'rental-bills' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT * FROM contracts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
          const contract = rows[0];
          const [lastBills] = await tx.execute(
            'SELECT period_end FROM bills WHERE contract_id = ? AND source = ? ORDER BY period_end DESC LIMIT 1 FOR UPDATE',
            [id, 'rental']
          );
          const bill = buildNextRentalBill(contract, lastBills.length ? String(lastBills[0].period_end).slice(0, 10) : null, today);
          const inserted = await tx.insert('bills', bill);
          return { id: Number(inserted.insertId), ...bill };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  // Bounded tenant-wide batch entry point for schedulers. Each call is one audited
  // tenant transaction and advances by contract ID; callers can resume with the
  // returned cursor without loading an unbounded contract set.
  router.post('/rental-bills/generate-due', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => !['as_of', 'after_contract_id', 'limit'].includes(key))) {
        throw contractError('RENTAL_BILL_BATCH_INPUT_INVALID');
      }
      const asOf = body.as_of === undefined ? new Date().toISOString().slice(0, 10) : body.as_of;
      const afterId = body.after_contract_id === undefined ? 0 : Number(body.after_contract_id);
      const limit = body.limit === undefined ? 50 : Number(body.limit);
      if (!validDate(asOf) || !Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw contractError('RENTAL_BILL_BATCH_INPUT_INVALID');
      }
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { as_of: asOf, after_contract_id: afterId, limit, __resource: 'rental-bill-batch' },
        mutate: async tx => {
          const [contracts] = await tx.execute(
            "SELECT * FROM contracts WHERE status = 'active' AND id > ? ORDER BY id ASC LIMIT ? FOR UPDATE",
            [afterId, limit + 1]
          );
          const batch = contracts.slice(0, limit);
          const bills = [];
          let skipped = 0;
          for (const contract of batch) {
            const [lastBills] = await tx.execute(
              'SELECT period_end FROM bills WHERE contract_id = ? AND source = ? ORDER BY period_end DESC LIMIT 1 FOR UPDATE',
              [contract.id, 'rental']
            );
            try {
              const bill = buildNextRentalBill(
                contract,
                lastBills.length ? String(lastBills[0].period_end).slice(0, 10) : null,
                asOf
              );
              const inserted = await tx.insert('bills', bill);
              bills.push({ id: Number(inserted.insertId), ...bill });
            } catch (error) {
              if (['RENTAL_BILL_NOT_DUE', 'CONTRACT_PERIOD_FINISHED'].includes(error.code)) {
                skipped += 1;
                continue;
              }
              throw error;
            }
          }
          const cursor = batch.length ? Number(batch[batch.length - 1].id) : afterId;
          return {
            as_of: asOf, after_contract_id: afterId, next_after_contract_id: cursor,
            processed_count: batch.length, generated_count: bills.length, skipped_count: skipped,
            has_more: contracts.length > limit, bills
          };
        }
      });
      return res.status(200).json(result);
    } catch (error) { return next(error); }
  });

  router.post('/rental-bills/generation-jobs', async (req,res,next) => {
    try {
      if(typeof req.tenantWrite!=='function') return res.status(503).json({error:'TENANT_WRITE_UNAVAILABLE'});
      const body=req.body;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='as_of')||!validDate(body.as_of)) throw contractError('RENTAL_BILL_JOB_INPUT_INVALID');
      const requestId=req.get('idempotency-key');
      const result=await req.tenantWrite({operation:'create',reason:req.get('x-operation-reason'),stepUpToken:req.get('x-step-up-token'),requestId,
        payload:{as_of:body.as_of,__resource:'rental-bill-generation-jobs'},
        mutate:async tx=>{
          await tx.execute("INSERT INTO rental_bill_generation_jobs (as_of_date,request_id,state) VALUES (?,?,'queued') ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",[body.as_of,requestId]);
          const [rows]=await tx.execute('SELECT id,as_of_date,request_id,state,cursor_contract_id,generated_count,skipped_count,created_at,updated_at,completed_at FROM rental_bill_generation_jobs WHERE as_of_date=? OR request_id=? ORDER BY id LIMIT 1 FOR UPDATE',[body.as_of,requestId]);
          if(!rows.length) throw contractError('RENTAL_BILL_JOB_CREATE_FAILED',500);
          if(rentalDateOnly(rows[0].as_of_date)!==body.as_of) throw contractError('RENTAL_BILL_JOB_IDEMPOTENCY_CONFLICT',409);
          return mapRentalBillJob(rows[0]);
        }});
      return res.status(201).json(result);
    } catch(error) { return next(error); }
  });
  router.get('/rental-bills/generation-jobs/:jobId', async (req,res,next) => {
    try {
      if(!req.tenantDb||typeof req.tenantDb.execute!=='function') return res.status(503).json({error:'TENANT_DATABASE_UNAVAILABLE'});
      const id=validateRentalBillJobId(req.params.jobId);
      const [rows]=await req.tenantDb.execute('SELECT id,as_of_date,state,cursor_contract_id,generated_count,skipped_count,created_at,updated_at,completed_at FROM rental_bill_generation_jobs WHERE id=? LIMIT 1',[id]);
      if(!rows.length) throw contractError('RENTAL_BILL_JOB_NOT_FOUND',404);
      return res.json(mapRentalBillJob(rows[0]));
    } catch(error) { return next(error); }
  });
  router.post('/rental-bills/generation-jobs/:jobId/process', async (req,res,next) => {
    try {
      if(typeof req.tenantWrite!=='function') return res.status(503).json({error:'TENANT_WRITE_UNAVAILABLE'});
      if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length) throw contractError('RENTAL_BILL_JOB_PROCESS_INPUT_INVALID');
      const id=validateRentalBillJobId(req.params.jobId);
      const result=await req.tenantWrite({operation:'update',reason:req.get('x-operation-reason'),stepUpToken:req.get('x-step-up-token'),requestId:req.get('idempotency-key'),
        payload:{job_id:id,__resource:'rental-bill-generation-job-process'},
        mutate:async tx=>{
          const [jobs]=await tx.execute('SELECT id,as_of_date,state,cursor_contract_id,generated_count,skipped_count,created_at,updated_at,completed_at FROM rental_bill_generation_jobs WHERE id=? LIMIT 1 FOR UPDATE',[id]);
          if(!jobs.length) throw contractError('RENTAL_BILL_JOB_NOT_FOUND',404);
          const job=jobs[0]; if(job.state==='completed') return mapRentalBillJob(job);
          const [contracts]=await tx.execute("SELECT * FROM contracts WHERE status='active' AND id>? ORDER BY id ASC LIMIT ? FOR UPDATE",[Number(job.cursor_contract_id||0),RENTAL_BILL_JOB_CHUNK_SIZE+1]);
          const chunk=contracts.slice(0,RENTAL_BILL_JOB_CHUNK_SIZE); let generated=0,skipped=0;
          for(const contract of chunk) {
            const [lastBills]=await tx.execute('SELECT period_end FROM bills WHERE contract_id=? AND source=? ORDER BY period_end DESC LIMIT 1 FOR UPDATE',[contract.id,'rental']);
            try {
              const bill=buildNextRentalBill(contract,lastBills.length?String(lastBills[0].period_end).slice(0,10):null,rentalDateOnly(job.as_of_date));
              await tx.insert('bills',bill); generated++;
            } catch(error) {
              if(['RENTAL_BILL_NOT_DUE','CONTRACT_PERIOD_FINISHED'].includes(error.code)){skipped++;continue;}
              throw error;
            }
          }
          const cursor=chunk.length?Number(chunk[chunk.length-1].id):Number(job.cursor_contract_id||0);
          const complete=contracts.length<=RENTAL_BILL_JOB_CHUNK_SIZE;
          await tx.execute("UPDATE rental_bill_generation_jobs SET state=?,cursor_contract_id=?,generated_count=generated_count+?,skipped_count=skipped_count+?,completed_at=CASE WHEN ?='completed' THEN UTC_TIMESTAMP() ELSE NULL END,updated_at=UTC_TIMESTAMP() WHERE id=?",
            [complete?'completed':'running',cursor,generated,skipped,complete?'completed':'running',id]);
          return {id,as_of:String(job.as_of_date).slice(0,10),state:complete?'completed':'running',cursor_contract_id:cursor,
            generated:Number(job.generated_count||0)+generated,skipped:Number(job.skipped_count||0)+skipped,
            processed_this_run:chunk.length,chunk_size:RENTAL_BILL_JOB_CHUNK_SIZE,has_more:!complete};
        }});
      return res.json(result);
    } catch(error) { return next(error); }
  });

  router.post('/contracts/:id/renew', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw contractError('CONTRACT_RENEWAL_INPUT_INVALID');
      const renewal = validateContractRenewal(req.body);
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, ...renewal, __resource: 'contract-renewals' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT * FROM contracts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
          const current = rows[0];
          if (current.status !== 'active') throw contractError('CONTRACT_NOT_ACTIVE', 409);
          const currentEnd = String(current.end_date).slice(0, 10);
          if (renewal.end_date <= currentEnd) throw contractError('CONTRACT_RENEWAL_MUST_EXTEND', 409);
          const patch = { end_date: renewal.end_date };
          for (const field of ['rent', 'deposit', 'pay_cycle', 'remark']) {
            if (Object.hasOwn(renewal, field)) patch[field] = renewal[field];
          }
          await tx.updateById('contracts', id, patch);
          return { id, status: 'active', ...patch, previous_end_date: currentEnd };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.post('/contracts/:id/terminate', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      const body = req.body;
      if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== 'object' ||
          Array.isArray(body) || Object.keys(body).length !== 1 || !validDate(body.termination_date)) {
        throw contractError('CONTRACT_TERMINATION_INPUT_INVALID');
      }
      const terminationDate = body.termination_date;
      const today = new Date().toISOString().slice(0, 10);
      if (terminationDate > today) throw contractError('CONTRACT_TERMINATION_DATE_IN_FUTURE');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, termination_date: terminationDate, __resource: 'contract-terminations' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, room_id, tenant_id, start_date, end_date, deposit, status FROM contracts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
          const contract = rows[0];
          if (contract.status !== 'active') throw contractError('CONTRACT_STATUS_TRANSITION_INVALID', 409);
          const startDate = String(contract.start_date).slice(0, 10);
          if (terminationDate < startDate) throw contractError('CONTRACT_TERMINATION_BEFORE_START', 409);
          const [balances] = await tx.execute(
            "SELECT COUNT(*) AS outstanding_count, COALESCE(SUM(GREATEST(amount - paid_amount, 0)), 0) AS outstanding_amount FROM bills WHERE contract_id = ? AND source = 'rental' AND status <> 'paid'",
            [id]
          );
          const outstandingCount = Number(balances[0].outstanding_count || 0);
          const outstandingAmount = Number(balances[0].outstanding_amount || 0);
          if (outstandingCount > 0 || outstandingAmount > 0) {
            throw Object.assign(new Error('CONTRACT_HAS_OUTSTANDING_BILLS'), {
              code: 'CONTRACT_HAS_OUTSTANDING_BILLS', status: 409,
              details: { outstanding_count: outstandingCount, outstanding_amount: outstandingAmount }
            });
          }
          await tx.updateById('contracts', id, { status: 'terminated', end_date: terminationDate });
          const [other] = await tx.execute(
            "SELECT id FROM contracts WHERE room_id = ? AND status = 'active' AND id <> ? LIMIT 1 FOR UPDATE",
            [contract.room_id, id]
          );
          if (!other.length) await tx.updateById('rooms', contract.room_id, { status: 'vacant' });
          return {
            id, status: 'terminated', termination_date: terminationDate,
            outstanding_amount: 0,
            deposit_settlement: {
              status: Number(contract.deposit) > 0 ? 'pending' : 'not_required',
              deposit_amount: Number(contract.deposit) || 0,
              note: '押金退款或抵扣须经独立财务流水确认，本接口不会虚报已退款'
            }
          };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  const depositActions = [
    { path: 'receive', type: 'receipt', operation: 'create', activeOnly: true },
    { path: 'refund', type: 'refund', operation: 'update', terminatedOnly: true },
    { path: 'deduct', type: 'deduction', operation: 'update', terminatedOnly: true }
  ];
  for (const action of depositActions) {
    router.post('/contracts/:id/deposit/' + action.path, async (req, res, next) => {
      try {
        if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1) throw contractError('RENTAL_DEPOSIT_CONTRACT_ID_INVALID');
        const transaction = validateRentalDepositTransaction(req.body, action.type);
        const requestId = req.get('idempotency-key');
        const result = await req.tenantWrite({
          operation: action.operation, reason: req.get('x-operation-reason'),
          stepUpToken: req.get('x-step-up-token'), requestId,
          payload: { contract_id: id, ...transaction, __resource: 'rental-contract-deposits-' + action.path },
          mutate: async tx => {
            const [rows] = await tx.execute('SELECT id, deposit, status FROM contracts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
            if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
            const contract = rows[0];
            const expectedMinor = parseMinorUnits(contract.deposit, { allowZero: true, maxMinor: 10000000000 });
            if (expectedMinor === null) throw contractError('RENTAL_DEPOSIT_BALANCE_INVALID', 409);
            const expected_amount = expectedMinor / 100;
            if (action.activeOnly && contract.status !== 'active') throw contractError('RENTAL_DEPOSIT_RECEIPT_REQUIRES_ACTIVE_CONTRACT', 409);
            if (action.terminatedOnly && contract.status !== 'terminated') throw contractError('RENTAL_DEPOSIT_SETTLEMENT_REQUIRES_TERMINATED_CONTRACT', 409);
            const balance = await readRentalDepositBalance(tx, id);
            const receivedMinor = parseMinorUnits(balance.received_amount, { allowZero: true, maxMinor: 10000000000 });
            const heldMinor = parseMinorUnits(balance.held_amount, { allowZero: true, maxMinor: 10000000000 });
            const transactionMinor = parseMinorUnits(transaction.amount);
            if (receivedMinor === null || heldMinor === null || transactionMinor === null || receivedMinor > expectedMinor) {
              throw contractError('RENTAL_DEPOSIT_BALANCE_INVALID', 409);
            }
            if (action.type === 'receipt' && transactionMinor > expectedMinor - receivedMinor) {
              throw contractError('RENTAL_DEPOSIT_RECEIPT_EXCEEDS_EXPECTED', 409);
            }
            if (action.type !== 'receipt' && (heldMinor <= 0 || transactionMinor > heldMinor)) {
              throw contractError('RENTAL_DEPOSIT_SETTLEMENT_EXCEEDS_HELD', 409);
            }
            await tx.execute(
              'INSERT INTO rental_contract_deposit_transactions (contract_id, transaction_type, amount, pay_method, external_reference, note, request_id, transaction_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [id, action.type, transaction.amount, transaction.pay_method, transaction.external_reference, transaction.note, requestId, transaction.transaction_date]
            );
            const next = await readRentalDepositBalance(tx, id);
            return { contract_id: id, expected_amount, ...next,
              remaining_to_receive: (expectedMinor - parseMinorUnits(next.received_amount, { allowZero: true, maxMinor: 10000000000 })) / 100,
              settlement_status: next.held_amount <= 0 && next.received_amount > 0 ? 'settled' :
                (next.refunded_amount + next.deducted_amount > 0 ? 'partially_settled' : 'pending') };
          }
        });
        return res.status(201).json(result);
      } catch (error) { return next(error); }
    });
  }
  router.get('/contracts/:id/deposit', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw contractError('RENTAL_DEPOSIT_CONTRACT_ID_INVALID');
      const [rows] = await req.tenantDb.execute('SELECT id, deposit, status FROM contracts WHERE id = ? LIMIT 1', [id]);
      if (!rows.length) throw contractError('CONTRACT_NOT_FOUND', 404);
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const pageSize = req.query.page_size === undefined ? 50 : Number(req.query.page_size);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw contractError('RENTAL_DEPOSIT_PAGINATION_INVALID');
      }
      const offset = (page - 1) * pageSize;
      const balance = await readRentalDepositBalance(req.tenantDb, id);
      const [[countRows], [transactions]] = await Promise.all([
        req.tenantDb.execute('SELECT COUNT(*) AS total_count FROM rental_contract_deposit_transactions WHERE contract_id = ?', [id]),
        req.tenantDb.execute(
          'SELECT id, transaction_type, amount, pay_method, external_reference, note, transaction_date, created_at FROM rental_contract_deposit_transactions WHERE contract_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
          [id, pageSize, offset]
        )
      ]);
      const expectedMinor = parseMinorUnits(rows[0].deposit, { allowZero: true, maxMinor: 10000000000 });
      if (expectedMinor === null) throw contractError('RENTAL_DEPOSIT_BALANCE_INVALID', 409);
      const expected_amount = expectedMinor / 100;
      const receivedMinor = parseMinorUnits(balance.received_amount, { allowZero: true, maxMinor: 10000000000 });
      if (receivedMinor === null || receivedMinor > expectedMinor) throw contractError('RENTAL_DEPOSIT_BALANCE_INVALID', 409);
      return res.json({ contract_id: id, contract_status: rows[0].status, expected_amount, ...balance,
        remaining_to_receive: (expectedMinor - receivedMinor) / 100,
        settlement_status: balance.held_amount <= 0 && balance.received_amount > 0 ? 'settled' :
          (balance.refunded_amount + balance.deducted_amount > 0 ? 'partially_settled' : 'pending'),
        page, page_size: pageSize, total_count: Number(countRows[0].total_count || 0),
        transactions });
    } catch (error) { return next(error); }
  });
  router.patch('/contracts/:id', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1 || !req.body || Object.keys(req.body).length !== 1 || req.body.status !== 'expired') throw contractError('CONTRACT_INPUT_INVALID');
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

module.exports = { ALLOWED_FIELDS, validateRoom, validateContract, validateContractRenewal, validateRentalDepositTransaction, validateRentalBillJobId, buildNextRentalBill, createRentalWriteRouter };
