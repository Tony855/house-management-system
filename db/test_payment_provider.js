'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createHmacSha256Verifier, createPaymentProviderRegistry } = require('../services/platform-api/payment-provider');

test('webhook verifier checks raw bytes using constant-time HMAC comparison', () => {
  const secret = 'test-secret-that-is-at-least-thirty-two-bytes';
  const body = Buffer.from('{"id":"evt_123","type":"payment.succeeded"}');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const verify = createHmacSha256Verifier({ secret });
  assert.equal(verify({ headers: { 'x-provider-signature': 'sha256=' + signature }, rawBody: body }), true);
  assert.equal(verify({ headers: { 'x-provider-signature': signature }, rawBody: Buffer.from(body.toString() + ' ') }), false);
  assert.equal(verify({ headers: {}, rawBody: body }), false);
  assert.equal(verify({ headers: { 'x-provider-signature': signature }, rawBody: body.toString() }), false);
});

test('payment provider registry rejects incomplete adapters and does not guess providers', () => {
  assert.throws(() => createPaymentProviderRegistry({ demo: {} }), /PAYMENT_PROVIDER_ADAPTER_INVALID/);
  const adapter = { createPaymentIntent: async () => {}, refundPayment: async () => {}, verifyWebhook: () => true, parseWebhookEvent: () => ({}) };
  const registry = createPaymentProviderRegistry({ demo: adapter });
  assert.deepEqual(registry.names(), ['demo']);
  assert.equal(registry.get('demo'), adapter);
  assert.equal(registry.get('unknown'), null);
});
