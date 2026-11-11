'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'tenant-schema-manifest.json'), 'utf8'));

function parseDatabases(sql) {
  const markers = [...sql.matchAll(/USE\s+(house_sys(?:_rental|_hotel|_property)?)\s*;/gi)];
  const output = {};
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index + markers[i][0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : sql.length;
    const block = sql.slice(start, end);
    output[markers[i][1]] = [...block.matchAll(/CREATE\s+TABLE\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*ENGINE=/gi)]
      .map(match => ({ name: match[1], hasOrgId: /^\s*org_id\s+/m.test(match[2]) }));
  }
  return output;
}

test('tenant schema manifest covers every legacy product table exactly once', () => {
  const parsed = parseDatabases(schema);
  for (const [product, expected] of Object.entries(manifest.products)) {
    const actual = parsed['house_sys_' + product].map(table => table.name).sort();
    assert.deepEqual(actual, [...expected].sort(), product + ' table inventory changed; update manifest and migration plan');
    assert.ok(parsed['house_sys_' + product].every(table => table.hasOrgId), product + ' legacy table is expected to be org-scoped');
  }
});

test('platform manifest does not include tenant business tables or identities', () => {
  assert.ok(!manifest.platformTables.includes('users'));
  assert.ok(!manifest.platformTables.includes('tenants'));
  assert.equal(manifest.migrationRules.sessions, 'revoke all legacy sessions; require fresh login');
});


test('tenant identity schema is separate and does not create a legacy sessions table', () => {
  const identitySql = fs.readFileSync(path.join(__dirname, 'migrations/tenant/001_tenant_identity.sql'), 'utf8');
  for (const table of manifest.tenantIdentityTables) assert.match(identitySql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\b'));
  assert.doesNotMatch(identitySql, /CREATE TABLE IF NOT EXISTS sessions\\b/i);
  assert.equal(manifest.migrationRules.sessions, 'never copy legacy sessions; revoke all and require fresh login through platform_product_sessions');
});
