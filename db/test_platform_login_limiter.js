'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformLoginRateLimiter } = require('../server/platform-adapters');

test('platform login limiter accepts 80-character usernames without storing raw identity', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [[], []];
    }
  };
  const limiter = createPlatformLoginRateLimiter(pool, {
    hmacKey: 'test-login-hmac-key-material-at-least-32-bytes'
  });
  const identity = { appId: 'platform', host: 'platform', username: 'u'.repeat(80) };
  assert.equal(await limiter.assertAllowed(identity), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'platform');
  assert.match(calls[0].params[1], /^[a-f0-9]{64}$/);
  assert.equal(calls[0].params[1].includes(identity.username), false);
});

test('platform login limiter rejects usernames beyond the authentication contract', async () => {
  const limiter = createPlatformLoginRateLimiter({ query: async () => [[], []] }, {
    hmacKey: 'test-login-hmac-key-material-at-least-32-bytes'
  });
  await assert.rejects(
    limiter.assertAllowed({ appId: 'platform', host: 'platform', username: 'u'.repeat(81) }),
    /LOGIN_RATE_LIMIT_IDENTITY_INVALID/
  );
});
