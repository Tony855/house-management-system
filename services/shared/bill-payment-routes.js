'use strict';
const express = require('express');
function paymentError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validateBillPayment(input) {
  const allowed = new Set(['amount','pay_method','pay_date']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) throw paymentError('BILL_PAYMENT_INPUT_INVALID');
  const amount = Number(input.amount);
  const pay_method = input.pay_method === undefined ? '' : input.pay_method;
  const pay_date = input.pay_date;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Math.round(amount * 100) !== amount * 100 ||
      typeof pay_method !== 'string' || pay_method.length > 30 ||
      (pay_date !== undefined && (typeof pay_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pay_date) || !Number.isFinite(Date.parse(pay_date + 'T00:00:00Z')) || new Date(pay_date + 'T00:00:00Z').toISOString().slice(0,10) !== pay_date))) {
    throw paymentError('BILL_PAYMENT_INPUT_INVALID');
  }
  return Object.freeze({ amount, pay_method, pay_date: pay_date || new Date().toISOString().slice(0,10) });
}
function createBillPaymentRouter(appId) {
  if (!['rental','hotel','property'].includes(appId)) throw new TypeError('BILL_PAYMENT_APP_INVALID');
  const router = express.Router();
  router.post('/bills/:id/pay', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), payment = validateBillPayment(req.body);
      if (!Number.isSafeInteger(id) || id < 1) throw paymentError('BILL_ID_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId: req.get('idempotency-key'), payload: { id, ...payment, __resource: 'bill-payments' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, amount, paid_amount, status, room_id, pay_method FROM bills WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw paymentError('BILL_NOT_FOUND', 404);
          const bill = rows[0], total = Number(bill.amount), alreadyPaid = Number(bill.paid_amount);
          if (!Number.isFinite(total) || total < 0 || !Number.isFinite(alreadyPaid) || alreadyPaid < 0 || alreadyPaid > total) throw paymentError('BILL_BALANCE_INVALID', 409);
          const remaining = Math.round((total - alreadyPaid) * 100) / 100;
          if (remaining <= 0 || payment.amount > remaining) throw paymentError('BILL_PAYMENT_EXCEEDS_BALANCE', 409);
          const paid_amount = Math.round((alreadyPaid + payment.amount) * 100) / 100;
          const status = paid_amount >= total ? 'paid' : 'partial';
          const patch = { paid_amount, status, pay_date: payment.pay_date };
          if (payment.pay_method) patch.pay_method = payment.pay_method;
          await tx.updateById('bills', id, patch);
          return { id, amount: total, paid_amount, remaining: Math.round((total - paid_amount) * 100) / 100, status, pay_method: payment.pay_method || bill.pay_method || '', pay_date: payment.pay_date };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { validateBillPayment, createBillPaymentRouter };
