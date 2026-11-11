'use strict';

const crypto = require('node:crypto');

function createHmacSha256Verifier({ secret, signatureHeader = 'x-provider-signature' } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('PAYMENT_WEBHOOK_SECRET_INVALID');
  if (typeof signatureHeader !== 'string' || !/^[a-z0-9-]{3,80}$/i.test(signatureHeader)) throw new TypeError('PAYMENT_SIGNATURE_HEADER_INVALID');
  return function verifyWebhook({ headers, rawBody }) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
    const supplied = headers && (headers[signatureHeader] || headers[signatureHeader.toLowerCase()]);
    if (typeof supplied !== 'string') return false;
    const signature = supplied.startsWith('sha256=') ? supplied.slice(7) : supplied;
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
}

function createPaymentProviderRegistry(adapters = {}) {
  const entries = new Map();
  for (const [name, adapter] of Object.entries(adapters)) {
    if (!/^[a-z0-9_-]{2,40}$/i.test(name) || !adapter ||
        typeof adapter.createPaymentIntent !== 'function' ||
        typeof adapter.refundPayment !== 'function' ||
        typeof adapter.verifyWebhook !== 'function' ||
        typeof adapter.parseWebhookEvent !== 'function') {
      throw new TypeError('PAYMENT_PROVIDER_ADAPTER_INVALID');
    }
    entries.set(name, Object.freeze(adapter));
  }
  return Object.freeze({
    get(name) { return entries.get(name) || null; },
    names() { return [...entries.keys()]; }
  });
}

module.exports = { createHmacSha256Verifier, createPaymentProviderRegistry };
