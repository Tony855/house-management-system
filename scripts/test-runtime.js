'use strict';
const assert = require('assert');
const expressVersion = require('express/package.json').version;
const mysqlVersion = require('mysql2/package.json').version;
const nodeMajor = Number(process.versions.node.split('.')[0]);
function tuple(version) { return version.split('.').map(Number); }
function atLeast(actual, minimum) {
  const a = tuple(actual), b = tuple(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
assert.equal(Number(expressVersion.split('.')[0]), 5, 'Express 5 is required');
assert.ok(atLeast(mysqlVersion, '3.24.6'), 'mysql2 3.24.6 or newer is required');
assert.ok(nodeMajor >= 24 && nodeMajor < 27, 'Node.js 24 or 26 LTS is required; alpha majors are not supported');
console.log(`Runtime dependency check passed: Node ${process.versions.node}, Express ${expressVersion}, mysql2 ${mysqlVersion}`);
