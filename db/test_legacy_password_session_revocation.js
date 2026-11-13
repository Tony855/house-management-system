'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createLegacyPasswordStore } = require('../server/legacy-password-store');

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
const passwordHash = '0123456789abcdef:' + 'a'.repeat(64);

test('legacy password store atomically updates the password and revokes all user sessions', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('BEGIN'),
    query: async (sql, params) => { calls.push([sql, params]); return [{ affectedRows: 1 }, []]; },
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE')
  };
  const store = createLegacyPasswordStore({ getConnection: async () => connection });
  assert.equal(await store.updatePasswordAndRevokeSessions({
    userId: 17, passwordHash, realName: 'Tenant Admin'
  }), true);
  assert.deepEqual(calls, [
    'BEGIN',
    ['UPDATE users SET password = ?, real_name = ? WHERE id = ?', [passwordHash, 'Tenant Admin', 17]],
    ['DELETE FROM sessions WHERE user_id = ?', [17]],
    'COMMIT',
    'RELEASE'
  ]);
});

test('legacy password store rolls back if session revocation fails', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('BEGIN'),
    query: async sql => {
      calls.push(sql);
      if (sql.startsWith('DELETE FROM sessions')) throw new Error('session store unavailable');
      return [{ affectedRows: 1 }, []];
    },
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE')
  };
  const store = createLegacyPasswordStore({ getConnection: async () => connection });
  await assert.rejects(store.updatePasswordAndRevokeSessions({ userId: 17, passwordHash }),
    /session store unavailable/);
  assert.deepEqual(calls, ['BEGIN', 'UPDATE users SET password = ? WHERE id = ?', 'DELETE FROM sessions WHERE user_id = ?', 'ROLLBACK', 'RELEASE']);
  assert.equal(calls.includes('COMMIT'), false);
});

test('legacy account password update routes all use the atomic revocation service', () => {
  assert.equal((source.match(/legacyPasswordStore\.updatePasswordAndRevokeSessions\(/g) || []).length, 3);
  assert.doesNotMatch(source, /UPDATE users SET password = \?/);
});

test('legacy async route wrapper redacts internal server errors and bounds status codes', () => {
  assert.match(source, /const status = Number\.isInteger\(e\?\.status\) && e\.status >= 400 && e\.status <= 599 \? e\.status : 500;/);
  assert.match(source, /const message = status >= 500 \? '服务错误'/);
  assert.doesNotMatch(source, /res\.status\(e\.status \|\| 500\)\.json\(\{ error: e\.message \}\)/);
});

test('legacy login throttling maps use bounded LRU insertion', () => {
  assert.match(source, /function setBoundedLoginEntry\(map, key, value, maxEntries\)/);
  assert.match(source, /setBoundedLoginEntry\(loginHits, ip, hit, 10000\)/);
  assert.match(source, /setBoundedLoginEntry\(loginFails, failKey, f, 50000\)/);
});
