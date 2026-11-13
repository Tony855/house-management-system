
const express = require('express');
const { parseMinorUnits } = require('../../server/money');
function hotelError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function hotelDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function validateHotelOrder(input) {
  const allowed = new Set(['order_no', 'room_id', 'guest_id', 'check_in_date', 'check_out_date', 'remark']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) throw hotelError('HOTEL_ORDER_INPUT_INVALID');
  const room_id = Number(input.room_id), guest_id = Number(input.guest_id);
  const start = hotelDate(input.check_in_date), end = hotelDate(input.check_out_date);
  if (!Number.isSafeInteger(room_id) || room_id < 1 || !Number.isSafeInteger(guest_id) || guest_id < 1 ||
      typeof input.order_no !== 'string' || !input.order_no.trim() || input.order_no.trim().length > 50 ||
      !start || !end || end <= start || typeof (input.remark || '') !== 'string' || (input.remark || '').length > 200) throw hotelError('HOTEL_ORDER_INPUT_INVALID');
  const days = Math.round((end - start) / 86400000);
  if (days < 1 || days > 366) throw hotelError('HOTEL_ORDER_INPUT_INVALID');
  return Object.freeze({ order_no: input.order_no.trim(), room_id, guest_id, check_in_date: input.check_in_date, check_out_date: input.check_out_date, days, remark: input.remark || '' });
}
function validateHotelDepositTransaction(input) {
  const allowed = new Set(['amount', 'pay_method', 'transaction_date', 'external_reference', 'note']);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.has(key))) throw hotelError('HOTEL_DEPOSIT_INPUT_INVALID');
  const amount = Number(input.amount);
  const pay_method = input.pay_method === undefined ? '' : input.pay_method;
  const transaction_date = input.transaction_date === undefined ? new Date().toISOString().slice(0, 10) : input.transaction_date;
  const external_reference = input.external_reference === undefined ? '' : input.external_reference;
  const note = input.note === undefined ? '' : input.note;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Math.round(amount * 100) !== amount * 100 ||
      typeof pay_method !== 'string' || pay_method.length > 30 || !hotelDate(transaction_date) ||
      typeof external_reference !== 'string' || external_reference.length > 100 ||
      typeof note !== 'string' || note.length > 500) throw hotelError('HOTEL_DEPOSIT_INPUT_INVALID');
  return Object.freeze({ amount, pay_method, transaction_date, external_reference, note });
}
async function readHotelDepositBalance(tx, orderId) {
  const [rows] = await tx.execute(
    "SELECT COALESCE(SUM(CASE WHEN transaction_type = 'receipt' THEN amount ELSE -amount END), 0) AS held_amount, COALESCE(SUM(CASE WHEN transaction_type = 'receipt' THEN amount ELSE 0 END), 0) AS received_amount, COALESCE(SUM(CASE WHEN transaction_type = 'refund' THEN amount ELSE 0 END), 0) AS refunded_amount FROM hotel_order_deposit_transactions WHERE order_id = ?",
    [orderId]
  );
  return {
    held_amount: Math.round(Number(rows[0].held_amount || 0) * 100) / 100,
    received_amount: Math.round(Number(rows[0].received_amount || 0) * 100) / 100,
    refunded_amount: Math.round(Number(rows[0].refunded_amount || 0) * 100) / 100
  };
}
function createHotelOrderRouter() {
  const router = express.Router();
  router.post('/orders', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const order = validateHotelOrder(req.body);
      const result = await req.tenantWrite({ operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { ...order, __resource: 'orders' },
        mutate: async tx => {
          const [rooms] = await tx.execute('SELECT id, day_price, deposit, status FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [order.room_id]);
          if (!rooms.length) throw hotelError('ROOM_NOT_FOUND', 404);
          if (rooms[0].status !== 'vacant') throw hotelError('ROOM_NOT_AVAILABLE', 409);
          const [guests] = await tx.execute('SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE', [order.guest_id]);
          if (!guests.length) throw hotelError('GUEST_NOT_FOUND', 404);
          const [overlaps] = await tx.execute("SELECT id FROM orders WHERE room_id = ? AND status IN ('booked','checked_in') AND check_in_date < ? AND check_out_date > ? LIMIT 1 FOR UPDATE", [order.room_id, order.check_out_date, order.check_in_date]);
          if (overlaps.length) throw hotelError('ROOM_BOOKING_OVERLAP', 409);
          const day_price = Number(rooms[0].day_price), deposit = Number(rooms[0].deposit);
          if (!Number.isFinite(day_price) || day_price < 0 || !Number.isFinite(deposit) || deposit < 0) throw hotelError('ROOM_PRICING_INVALID', 409);
          const total = Math.round(day_price * order.days * 100) / 100;
          const record = { ...order, day_price, deposit, total, status: 'booked' };
          const inserted = await tx.insert('orders', record);
          await tx.updateById('rooms', order.room_id, { status: 'booked' });
          return { id: Number(inserted.insertId), ...record };
        } });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.patch('/orders/:id/status', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), status = req.body && req.body.status;
      if (!Number.isSafeInteger(id) || id < 1 || !['checked_in','checked_out','cancelled'].includes(status) || Object.keys(req.body || {}).length !== 1) throw hotelError('HOTEL_ORDER_INPUT_INVALID');
      const result = await req.tenantWrite({ operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, status, __resource: 'orders' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, room_id, guest_id, order_no, check_in_date, check_out_date, total, status FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw hotelError('ORDER_NOT_FOUND', 404);
          const order = rows[0];
          const current = order.status;
          const allowed = (current === 'booked' && ['checked_in','cancelled'].includes(status)) || (current === 'checked_in' && status === 'checked_out');
          if (!allowed) throw hotelError('HOTEL_ORDER_TRANSITION_INVALID', 409);
          const now = new Date();
          const orderPatch = { status };
          if (status === 'checked_in') orderPatch.checkin_time = now;
          if (status === 'checked_out') orderPatch.checkout_time = now;
          await tx.updateById('orders', id, orderPatch);
          const roomStatus = status === 'checked_in' ? 'rented' : status === 'checked_out' ? 'cleaning' : 'vacant';
          await tx.updateById('rooms', order.room_id, { status: roomStatus });
          if (status === 'checked_out') {
            const [existingBills] = await tx.execute('SELECT id FROM bills WHERE order_id = ? LIMIT 1 FOR UPDATE', [id]);
            if (!existingBills.length) {
              const amount = Number(order.total);
              if (!Number.isFinite(amount) || amount < 0) throw hotelError('HOTEL_ORDER_AMOUNT_INVALID', 409);
              await tx.insert('bills', {
                source: 'hotel', room_id: order.room_id, tenant_id: order.guest_id, order_id: id,
                period_start: order.check_in_date, period_end: order.check_out_date,
                due_date: order.check_out_date, amount, paid_amount: 0, status: 'unpaid',
                remark: '订单 ' + order.order_no + ' 房费'
              });
            }
          }
          return { id, status, room_status: roomStatus };
        } });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  router.post('/rooms/:id/cleaning-complete', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1 || !req.body || typeof req.body !== 'object' ||
          Array.isArray(req.body) || Object.keys(req.body).length) throw hotelError('HOTEL_CLEANING_INPUT_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, __resource: 'hotel-room-cleaning' },
        mutate: async tx => {
          const [rooms] = await tx.execute('SELECT id, status FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rooms.length) throw hotelError('ROOM_NOT_FOUND', 404);
          if (rooms[0].status !== 'cleaning') throw hotelError('ROOM_NOT_IN_CLEANING', 409);
          const [activeOrders] = await tx.execute(
            "SELECT id FROM orders WHERE room_id = ? AND status IN ('booked','checked_in') LIMIT 1 FOR UPDATE", [id]
          );
          if (activeOrders.length) throw hotelError('ROOM_HAS_ACTIVE_ORDER', 409);
          await tx.updateById('rooms', id, { status: 'vacant' });
          return { room_id: id, status: 'vacant' };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  router.post('/orders/:id/deposit/receive', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), transaction = validateHotelDepositTransaction(req.body);
      const requestId = req.get('idempotency-key');
      if (!Number.isSafeInteger(id) || id < 1) throw hotelError('HOTEL_ORDER_ID_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId, payload: { id, ...transaction, __resource: 'hotel-order-deposits' },
        mutate: async tx => {
          const [orders] = await tx.execute('SELECT id, deposit, status FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!orders.length) throw hotelError('ORDER_NOT_FOUND', 404);
          const expected = Number(orders[0].deposit);
          if (!Number.isFinite(expected) || expected < 0) throw hotelError('HOTEL_DEPOSIT_BALANCE_INVALID', 409);
          const balance = await readHotelDepositBalance(tx, id);
          if (transaction.amount > Math.round((expected - balance.received_amount) * 100) / 100) {
            throw hotelError('HOTEL_DEPOSIT_RECEIPT_EXCEEDS_EXPECTED', 409);
          }
          await tx.execute(
            "INSERT INTO hotel_order_deposit_transactions (order_id, transaction_type, amount, pay_method, external_reference, note, request_id, transaction_date) VALUES (?, 'receipt', ?, ?, ?, ?, ?, ?)",
            [id, transaction.amount, transaction.pay_method, transaction.external_reference, transaction.note, requestId, transaction.transaction_date]
          );
          const nextBalance = await readHotelDepositBalance(tx, id);
          return { order_id: id, expected_amount: expected, ...nextBalance, remaining_to_receive: Math.round((expected - nextBalance.received_amount) * 100) / 100 };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.post('/orders/:id/deposit/refund', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id), transaction = validateHotelDepositTransaction(req.body);
      const requestId = req.get('idempotency-key');
      if (!Number.isSafeInteger(id) || id < 1) throw hotelError('HOTEL_ORDER_ID_INVALID');
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'), stepUpToken: req.get('x-step-up-token'),
        requestId, payload: { id, ...transaction, __resource: 'hotel-order-deposit-refunds' },
        mutate: async tx => {
          const [orders] = await tx.execute('SELECT id, deposit FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!orders.length) throw hotelError('ORDER_NOT_FOUND', 404);
          const expected = Number(orders[0].deposit);
          if (!Number.isFinite(expected) || expected < 0) throw hotelError('HOTEL_DEPOSIT_BALANCE_INVALID', 409);
          const balance = await readHotelDepositBalance(tx, id);
          if (transaction.amount > balance.held_amount || balance.held_amount <= 0) {
            throw hotelError('HOTEL_DEPOSIT_REFUND_EXCEEDS_HELD', 409);
          }
          await tx.execute(
            "INSERT INTO hotel_order_deposit_transactions (order_id, transaction_type, amount, pay_method, external_reference, note, request_id, transaction_date) VALUES (?, 'refund', ?, ?, ?, ?, ?, ?)",
            [id, transaction.amount, transaction.pay_method, transaction.external_reference, transaction.note, requestId, transaction.transaction_date]
          );
          const nextBalance = await readHotelDepositBalance(tx, id);
          return { order_id: id, expected_amount: expected, ...nextBalance, remaining_to_receive: Math.round((expected - nextBalance.held_amount) * 100) / 100 };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  router.get('/orders/:id/deposit', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw hotelError('HOTEL_ORDER_ID_INVALID');
      const [orders] = await req.tenantDb.execute('SELECT id, deposit FROM orders WHERE id = ? LIMIT 1', [id]);
      if (!orders.length) throw hotelError('ORDER_NOT_FOUND', 404);
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      const pageSize = req.query.page_size === undefined ? 50 : Number(req.query.page_size);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw hotelError('HOTEL_DEPOSIT_PAGINATION_INVALID');
      }
      const offset = (page - 1) * pageSize;
      const balance = await readHotelDepositBalance(req.tenantDb, id);
      const [[countRows], [transactions]] = await Promise.all([
        req.tenantDb.execute('SELECT COUNT(*) AS total_count FROM hotel_order_deposit_transactions WHERE order_id = ?', [id]),
        req.tenantDb.execute(
          'SELECT id, transaction_type, amount, pay_method, external_reference, note, transaction_date, created_at FROM hotel_order_deposit_transactions WHERE order_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
          [id, pageSize, offset]
        )
      ]);
      const expected = Number(orders[0].deposit);
      return res.json({ order_id: id, expected_amount: expected, ...balance,
        remaining_to_receive: Math.round((expected - balance.received_amount) * 100) / 100,
        page, page_size: pageSize, total_count: Number(countRows[0].total_count || 0), transactions });
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { validateHotelOrder, validateHotelDepositTransaction, createHotelOrderRouter };
