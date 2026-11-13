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
