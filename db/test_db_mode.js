'use strict';

const assert = require('assert');
const db = require('../server/db');

for (const mode of ['rental', 'hotel', 'property']) {
  assert.doesNotThrow(() => db.getPool(mode), 'known mode must resolve: ' + mode);
}

for (const mode of [undefined, null, '', 'super', 'unknown', '__proto__', 'constructor']) {
  assert.throws(
    () => db.getPool(mode),
    /Unsupported database mode/,
    'unknown mode must fail closed: ' + String(mode)
  );
}

console.log('PASS: database mode routing is fail-closed');
