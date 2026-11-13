'use strict';
const express = require('express');
const { parseMinorUnits } = require('../../server/money');
function paymentError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function validateBillTransaction(input) {
  const allowed = new Set(['amount','pay_method','pay_date','external_reference','note']);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.has(key))) throw paymentError('BILL_TRANSACTION_INPUT_INVALID');
  const amountMinor = parseMinorUnits(input.amount);
  const amount = amountMinor === null ? NaN : amountMinor / 100;
  const pay_method = input.pay_method === undefined ? '' : input.pay_method;
  const pay_date = input.pay_date === undefined ? new Date().toISOString().slice(0,10) : input.pay_date;
  const external_reference = input.external_reference === undefined ? '' : input.external_reference;
  const note = input.note === undefined ? '' : input.note;
  if (!Number.isFinite(amount) ||
      typeof pay_method !== 'string' || pay_method.length > 30 ||
      !validDate(pay_date) || typeof external_reference !== 'string' || external_reference.length > 100 ||
      typeof note !== 'string' || note.length > 500) throw paymentError('BILL_TRANSACTION_INPUT_INVALID');
  return Object.freeze({ amount, pay_method, pay_date, external_reference, note });
}
async function insertBillTransaction(tx, { billId, type, transaction, requestId }) {
  await tx.execute(
    'INSERT INTO bill_transactions (bill_id, transaction_type, amount, pay_method, external_reference, note, request_id, transaction_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [billId, type, transaction.amount, transaction.pay_method, transaction.external_reference, transaction.note, requestId, transaction.pay_date]
  );
}
function validateBillPayment(input) {
  try { return validateBillTransaction(input); }
  catch (_) { throw paymentError('BILL_PAYMENT_INPUT_INVALID'); }
}
function createBillPaymentRouter(appId) {
  if (!['rental','hotel','property'].includes(appId)) throw new TypeError('BILL_PAYMENT_APP_INVALID');
  const router = express.Router();
  router.post('/bills/:id/pay', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), transaction = validateBillTransaction(req.body);
      const requestId = req.get('idempotency-key');
      if (!Number.isSafeInteger(id) || id < 1) throw paymentError('BILL_ID_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId, payload: { id, ...transaction, __resource: 'bill-payments' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, amount, paid_amount, status, room_id, pay_method FROM bills WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw paymentError('BILL_NOT_FOUND', 404);
          const bill = rows[0];
          const totalMinor = parseMinorUnits(bill.amount, { allowZero: true });
          const alreadyPaidMinor = parseMinorUnits(bill.paid_amount, { allowZero: true });
          const transactionMinor = parseMinorUnits(transaction.amount);
          if (totalMinor === null || alreadyPaidMinor === null || transactionMinor === null || alreadyPaidMinor > totalMinor) {
            throw paymentError('BILL_BALANCE_INVALID', 409);
          }
          const remainingMinor = totalMinor - alreadyPaidMinor;
          if (remainingMinor <= 0 || transactionMinor > remainingMinor) throw paymentError('BILL_PAYMENT_EXCEEDS_BALANCE', 409);
          const paidMinor = alreadyPaidMinor + transactionMinor;
          const total = totalMinor / 100, paid_amount = paidMinor / 100, remaining = remainingMinor / 100;
          const status = paidMinor >= totalMinor ? 'paid' : 'partial';
          await insertBillTransaction(tx, { billId: id, type: 'receipt', transaction, requestId });
          const patch = { paid_amount, status, pay_date: transaction.pay_date };
          if (transaction.pay_method) patch.pay_method = transaction.pay_method;
          await tx.updateById('bills', id, patch);
          return { id, amount: total, paid_amount, remaining: (totalMinor - paidMinor) / 100, status, pay_method: transaction.pay_method || bill.pay_method || '', pay_date: transaction.pay_date, transaction_type: 'receipt' };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  router.post('/bills/:id/refund', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), transaction = validateBillTransaction(req.body);
      const requestId = req.get('idempotency-key');
      if (!Number.isSafeInteger(id) || id < 1) throw paymentError('BILL_ID_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId, payload: { id, ...transaction, __resource: 'bill-refunds' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, amount, paid_amount, status, pay_method, pay_date FROM bills WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw paymentError('BILL_NOT_FOUND', 404);
          const bill = rows[0];
          const totalMinor = parseMinorUnits(bill.amount, { allowZero: true });
          const alreadyPaidMinor = parseMinorUnits(bill.paid_amount, { allowZero: true });
          const transactionMinor = parseMinorUnits(transaction.amount);
          if (totalMinor === null || alreadyPaidMinor === null || transactionMinor === null || alreadyPaidMinor > totalMinor) {
            throw paymentError('BILL_BALANCE_INVALID', 409);
          }
          const total = totalMinor / 100, alreadyPaid = alreadyPaidMinor / 100;
          const [ledger] = await tx.execute(
            "SELECT COALESCE(SUM(CASE WHEN transaction_type = 'receipt' THEN amount WHEN transaction_type = 'refund' THEN -amount ELSE 0 END), 0) AS net_amount FROM bill_transactions WHERE bill_id = ?",
            [id]
          );
          const ledgerNetMinor = parseMinorUnits(ledger[0].net_amount || 0, { allowZero: true });
          if (ledgerNetMinor === null || ledgerNetMinor !== alreadyPaidMinor) throw paymentError('BILL_LEDGER_BALANCE_MISMATCH', 409);
          if (transactionMinor > alreadyPaidMinor || alreadyPaidMinor <= 0) throw paymentError('BILL_REFUND_EXCEEDS_PAID_AMOUNT', 409);
          const paidMinor = alreadyPaidMinor - transactionMinor;
          const paid_amount = paidMinor / 100;
          const status = paidMinor <= 0 ? 'unpaid' : 'partial';
          await insertBillTransaction(tx, { billId: id, type: 'refund', transaction, requestId });
          await tx.updateById('bills', id, { paid_amount, status, pay_date: paidMinor <= 0 ? null : bill.pay_date });
          return { id, amount: total, refunded_amount: transaction.amount, paid_amount, remaining: (totalMinor - paidMinor) / 100, status, transaction_type: 'refund', transaction_date: transaction.pay_date };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { validateBillTransaction, validateBillPayment, createBillPaymentRouter };
