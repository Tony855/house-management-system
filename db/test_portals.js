'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const apps = [['rental','rental_session'],['hotel','hotel_session'],['property','property_session'],['platform','platform_session']];
test('four independent portal entrypoints have distinct app and session boundaries', () => {
  const seen = new Set();
  for (const [app, cookie] of apps) {
    const dir = app === 'platform' ? 'super-admin' : app;
    const html = fs.readFileSync('apps/' + dir + '-web/index.html', 'utf8');
    const js = fs.readFileSync('apps/' + dir + '-web/portal.js', 'utf8');
    assert.ok(html.includes('data-app-id="' + app + '"'));
    assert.ok(html.includes('data-session-cookie="' + cookie + '"'));
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes("default-src 'self'"));
    assert.ok(html.includes('./portal.css'));
    assert.ok(fs.existsSync('apps/' + dir + '-web/portal.css'));
    assert.ok(js.includes("credentials: 'omit'"));
    assert.ok(js.includes('login-form'));
    assert.ok(js.includes("authorization = 'Bearer '"));
    assert.equal(js.includes('localStorage'), false);
    assert.equal(js.includes('sessionStorage'), false);
    assert.equal(html.includes('/js/10-auth.js'), false);
    seen.add(app);
  }
  assert.equal(seen.size, 4);
});
test('platform portal is separate and enforces the MFA login flow', () => {
  const html = fs.readFileSync('apps/super-admin-web/index.html', 'utf8');
  const js = fs.readFileSync('apps/super-admin-web/portal.js', 'utf8');
  assert.ok(html.includes('Super Admin'));
  assert.ok(html.includes('平台总管理'));
  assert.ok(html.includes('平台账单'));
  assert.ok(html.includes('禁止读取租户业务数据库'));
  assert.ok(js.includes('/api/platform/auth/mfa/verify'));
  assert.ok(js.includes('/api/platform/auth/login'));
});
