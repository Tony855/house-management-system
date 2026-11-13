'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');

test('legacy account password changes revoke all existing sessions for the affected user', () => {
  assert.match(source, /UPDATE users SET password = \?, real_name = \? WHERE id = \?['\x60],\s*\[await hashPasswordAsync\(password\), real_name \|\| '', exist\[0\]\.id\]\);\s*await shared\.query\('DELETE FROM sessions WHERE user_id = \?', \[exist\[0\]\.id\]\);/);
  assert.match(source, /UPDATE users SET password = \? WHERE id = \?['\x60], \[await hashPasswordAsync\(password\), o\.admin_user_id\]\);\s*await shared\.query\('DELETE FROM sessions WHERE user_id = \?', \[o\.admin_user_id\]\);/);
  assert.match(source, /UPDATE users SET password = \? WHERE id = \?['\x60], \[await hashPasswordAsync\(password\), req\.params\.id\]\);\s*await shared\.query\('DELETE FROM sessions WHERE user_id = \?', \[req\.params\.id\]\);/);
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
