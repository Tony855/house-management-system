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
    const html = fs.readFileSync('apps/' + app + '-web/index.html', 'utf8');
    const js = fs.readFileSync('apps/' + app + '-web/portal.js', 'utf8');
    assert.match(html, new RegExp('data-app-id="' + app + '"'));
    assert.match(html, new RegExp('data-session-cookie="' + cookie + '"'));
    assert.match(html, /type="module"/);
    assert.match(html, /\.\.\/portal\.css/);
    assert.match(js, /credentials:\s*'omit'/);
    assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie/);
    assert.doesNotMatch(html, /\/js\/(?:00-core|10-auth|20-dashboard|30-rooms|40-people|50-billing|60-operations|70-admin|90-bootstrap)\.js/);
    seen.add(app);
  }
  assert.equal(seen.size, 4);
});
test('platform portal is separate from tenant product entrypoints', () => {
  const html = fs.readFileSync('apps/platform-web/index.html', 'utf8');
  assert.match(html, /Super Admin/);
  assert.match(html, /平台总管理/);
  assert.match(html, /平台账单/);
  assert.match(html, /禁止读取租户业务数据库/);
});
