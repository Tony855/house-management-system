'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashPassword, verifyPassword, verifyPasswordAsync } = require('../server/util');

test('sync and async password verifiers accept existing scrypt hashes', async () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPasswordAsync('correct horse', stored), true);
  assert.equal(await verifyPasswordAsync('incorrect', stored), false);
});

test('password verifiers reject malformed stored hashes without throwing', async () => {
  for (const value of [null, '', 'broken', 'salt:xyz', 'a'.repeat(16) + ':' + '0'.repeat(62), 'salt:' + '0'.repeat(64), '0'.repeat(16) + ':' + '0'.repeat(64) + ':extra']) {
    assert.equal(verifyPassword('password', value), false);
    assert.equal(await verifyPasswordAsync('password', value), false);
  }
});
