'use strict';
const CURRENCY_EXPONENTS = Object.freeze({ BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0, BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3 });
const INVOICE_TRANSITIONS = Object.freeze({ draft: new Set(['open', 'void']), open: new Set(['paid', 'void', 'uncollectible']), paid: new Set([]), void: new Set([]), uncollectible: new Set(['paid', 'void']) });
const PAYMENT_TRANSITIONS = Object.freeze({ pending: new Set(['succeeded', 'failed']), succeeded: new Set(['partially_refunded', 'refunded']), failed: new Set([]), partially_refunded: new Set(['refunded']), refunded: new Set([]) });
function currencyExponent(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('BILLING_CURRENCY_INVALID');
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : 2;
}
function toMinorUnits(value, currency) {
  const exponent = currencyExponent(currency);
  const input = typeof value === 'number' ? String(value) : value;
  const match = typeof input === 'string' && input.match(/^(0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!match) throw new Error('BILLING_AMOUNT_INVALID');
  const whole = match[1], fraction = match[2] || '';
  if (fraction.length > exponent) throw new Error('BILLING_AMOUNT_PRECISION_INVALID');
  const scale = 10n ** BigInt(exponent);
  const fractional = exponent ? BigInt((fraction + '0'.repeat(exponent)).slice(0, exponent) || '0') : 0n;
  const result = BigInt(whole) * scale + fractional;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('BILLING_AMOUNT_TOO_LARGE');
  return Number(result);
}
function fromMinorUnits(value, currency) {
  if (!Number.isSafeInteger(value)) throw new Error('BILLING_MINOR_AMOUNT_INVALID');
  return (value / (10 ** currencyExponent(currency))).toFixed(currencyExponent(currency));
}
function assertTransition(kind, from, to) {
  const transitions = kind === 'invoice' ? INVOICE_TRANSITIONS : kind === 'payment' ? PAYMENT_TRANSITIONS : null;
  if (!transitions || !transitions[from] || !transitions[from].has(to)) throw new Error('BILLING_STATE_TRANSITION_INVALID');
  return true;
}
function invoiceTotalMinor({ subtotalMinor, discountMinor = 0, taxMinor = 0 }) {
  for (const value of [subtotalMinor, discountMinor, taxMinor]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('BILLING_MINOR_AMOUNT_INVALID');
  if (discountMinor > subtotalMinor) throw new Error('BILLING_DISCOUNT_EXCEEDS_SUBTOTAL');
  const total = subtotalMinor - discountMinor + taxMinor;
  if (!Number.isSafeInteger(total)) throw new Error('BILLING_AMOUNT_TOO_LARGE');
  return total;
}
function paymentIdempotencyKey(provider, providerEventId) {
  if (typeof provider !== 'string' || !/^[a-z0-9_-]{2,40}$/i.test(provider) || typeof providerEventId !== 'string' || !providerEventId || providerEventId.length > 160) throw new Error('BILLING_IDEMPOTENCY_INPUT_INVALID');
  return require('node:crypto').createHash('sha256').update(provider + ':' + providerEventId).digest('hex');
}
function assertRefundWithinBalance({ capturedMinor, refundedMinor = 0, requestedMinor }) {
  if (![capturedMinor, refundedMinor, requestedMinor].every(Number.isSafeInteger) || capturedMinor < 0 || refundedMinor < 0 || requestedMinor <= 0 || refundedMinor > capturedMinor || requestedMinor > capturedMinor - refundedMinor) throw new Error('BILLING_REFUND_EXCEEDS_CAPTURE');
  return capturedMinor - refundedMinor - requestedMinor;
}
module.exports = { currencyExponent, toMinorUnits, fromMinorUnits, assertTransition, invoiceTotalMinor, paymentIdempotencyKey, assertRefundWithinBalance };
