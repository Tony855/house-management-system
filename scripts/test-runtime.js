'use strict';
const assert = require('assert');
const fs = require('fs');
const expressVersion = require('express/package.json').version;
const mysqlVersion = require('mysql2/package.json').version;
const nodeMajor = Number(process.versions.node.split('.')[0]);
const appSource = fs.readFileSync('server/app.js', 'utf8');
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
assert.doesNotMatch(appSource, /\breq\.param\s*\(/, 'removed req.param API must not be used');
assert.doesNotMatch(appSource, /\bres\.sendfile\s*\(/, 'removed res.sendfile API must not be used');
assert.doesNotMatch(appSource, /\bapp\.del\s*\(/, 'removed app.del API must not be used');
assert.doesNotMatch(appSource, /\b(?:app|router)\.(?:get|all|use)\s*\(\s*['"](?:\*|\/\*)['"]/, 'Express 5 wildcard routes must use named wildcards');
assert.doesNotMatch(appSource, /\breq\.query\s*=/, 'Express 5 req.query is read-only');
console.log('Runtime dependency and Express 5 compatibility checks passed: Node ' + process.versions.node + ', Express ' + expressVersion + ', mysql2 ' + mysqlVersion);
