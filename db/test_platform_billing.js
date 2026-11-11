'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMinorUnits, fromMinorUnits, assertTransition, invoiceTotalMinor, paymentIdempotencyKey, assertRefundWithinBalance } = require('../services/platform-api/billing-domain');
test('money conversion is exact for USD, KHR and three-decimal currencies', () => {
  assert.equal(toMinorUnits('12.34', 'USD'), 1234);
  assert.equal(toMinorUnits('1200', 'KHR'), 1200);
  assert.equal(toMinorUnits('1.234', 'KWD'), 1234);
  assert.equal(fromMinorUnits(1234, 'USD'), '12.34');
  assert.equal(fromMinorUnits(1200, 'KHR'), '1200');
});
test('money rejects invalid, negative, exponent and excessive precision inputs', () => {
  for (const value of ['-1', '1e3', '1.001', '01.00', 'NaN', '']) assert.throws(() => toMinorUnits(value, 'USD'));
  assert.throws(() => toMinorUnits('1.1', 'KHR'), /BILLING_AMOUNT_PRECISION_INVALID/);
});
test('invoice totals validate amounts and prevent discounts above subtotal', () => {
  assert.equal(invoiceTotalMinor({ subtotalMinor: 1000, discountMinor: 100, taxMinor: 72 }), 972);
  assert.throws(() => invoiceTotalMinor({ subtotalMinor: 100, discountMinor: 101 }), /BILLING_DISCOUNT_EXCEEDS_SUBTOTAL/);
  assert.throws(() => invoiceTotalMinor({ subtotalMinor: -1 }), /BILLING_MINOR_AMOUNT_INVALID/);
});
test('invoice and payment state transitions are explicit and terminal states stay terminal', () => {
  assert.equal(assertTransition('invoice', 'open', 'paid'), true);
  assert.throws(() => assertTransition('invoice', 'paid', 'open'), /BILLING_STATE_TRANSITION_INVALID/);
  assert.throws(() => assertTransition('payment', 'failed', 'succeeded'), /BILLING_STATE_TRANSITION_INVALID/);
  assert.equal(assertTransition('payment', 'succeeded', 'partially_refunded'), true);
});
test('provider event idempotency key is deterministic and validates input', () => {
  const a = paymentIdempotencyKey('aba', 'evt-123');
  assert.equal(a, paymentIdempotencyKey('aba', 'evt-123'));
  assert.notEqual(a, paymentIdempotencyKey('aba', 'evt-124'));
  assert.throws(() => paymentIdempotencyKey('', 'evt-1'));
});
test('refunds cannot exceed captured balance', () => {
  assert.equal(assertRefundWithinBalance({ capturedMinor: 1000, refundedMinor: 200, requestedMinor: 300 }), 500);
  assert.throws(() => assertRefundWithinBalance({ capturedMinor: 1000, refundedMinor: 900, requestedMinor: 200 }), /BILLING_REFUND_EXCEEDS_CAPTURE/);
});
