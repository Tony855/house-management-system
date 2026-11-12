
const express = require('express');
function hotelError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function hotelDate(value) {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return null;
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
          const [rows] = await tx.execute('SELECT id, room_id, status FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw hotelError('ORDER_NOT_FOUND', 404);
          const current = rows[0].status;
          const allowed = (current === 'booked' && ['checked_in','cancelled'].includes(status)) || (current === 'checked_in' && status === 'checked_out');
          if (!allowed) throw hotelError('HOTEL_ORDER_TRANSITION_INVALID', 409);
          await tx.updateById('orders', id, { status });
          const roomStatus = status === 'checked_in' ? 'rented' : status === 'checked_out' ? 'cleaning' : 'vacant';
          await tx.updateById('rooms', rows[0].room_id, { status: roomStatus });
          return { id, status, room_status: roomStatus };
        } });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { validateHotelOrder, createHotelOrderRouter };
