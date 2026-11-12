'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const apps = [
  ['rental', 'rental_session'],
  ['hotel', 'hotel_session'],
  ['property', 'property_session'],
  ['platform', 'platform_session']
];
test('four independent portal entrypoints have distinct app and session boundaries', () => {
  const seen = new Set();
  for (const [app, cookie] of apps) {
    const dir = app === 'platform' ? 'super-admin' : app;
    const html = fs.readFileSync('apps/' + dir + '-web/index.html', 'utf8');
    const js = fs.readFileSync('apps/' + dir + '-web/portal.js', 'utf8');
    assert.match(html, new RegExp('data-app-id="' + app + '"'));
    assert.match(html, new RegExp('data-session-cookie="' + cookie + '"'));
    assert.match(html, /type="module"/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /default-src 'self'/);
    assert.match(html, /\\.\\/portal\\.css/);
    assert.ok(fs.existsSync('apps/' + dir + '-web/portal.css'));
    assert.match(js, /credentials:\\s*'omit'/);
    assert.match(js, /login-form/);
    assert.match(js, /authorization = 'Bearer '/);
    assert.doesNotMatch(js, /localStorage|sessionStorage|document\\.cookie/);
    assert.doesNotMatch(html, /\\/js\\/(?:00-core|10-auth|20-dashboard|30-rooms|40-people|50-billing|60-operations|70-admin|90-bootstrap)\\.js/);
    seen.add(app);
  }
  assert.equal(seen.size, 4);
});
test('platform portal is separate and enforces the MFA login flow', () => {
  const html = fs.readFileSync('apps/super-admin-web/index.html', 'utf8');
  const js = fs.readFileSync('apps/super-admin-web/portal.js', 'utf8');
  assert.match(html, /Super Admin/);
  assert.match(html, /平台总管理/);
  assert.match(html, /平台账单/);
  assert.match(html, /禁止读取租户业务数据库/);
  assert.match(js, /mfa\\/verify/);
  assert.match(js, /api\\/platform\\/auth\\/login/);
});
