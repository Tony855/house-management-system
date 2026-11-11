'use strict';
const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync('public/index.html', 'utf8');
const paths = [
  'public/js/00-core.js',
  'public/js/10-auth.js',
  'public/js/20-dashboard.js',
  'public/js/30-rooms.js',
  'public/js/40-people.js',
  'public/js/50-billing.js',
  'public/js/60-operations.js',
  'public/js/70-admin.js',
  'public/js/90-bootstrap.js'
];
let combined = '';
let previousIndex = -1;
for (const path of paths) {
  const src = fs.readFileSync(path, 'utf8');
  const url = '/' + path.replace(/^public\//, '');
  const index = html.indexOf('<script src="' + url + '" defer></script>');
  assert.ok(index > previousIndex, 'frontend modules must load in declared order: ' + path);
  previousIndex = index;
  combined += '\n' + src;
}
assert.ok(!html.includes('/app.js'), 'legacy monolithic bundle must not be referenced');
try {
  new Function(combined);
  console.log('Frontend module syntax and load-order checks passed: ' + paths.length + ' files, ' + combined.length + ' characters');
} catch (e) {
  const pos = e.stack.match(/<anonymous>:(\d+):(\d+)/);
  if (pos) {
    const ln = Number(pos[1]) - 1;
    const lines = combined.split('\n');
    console.error('Frontend JS syntax error at combined line ' + ln + ': ' + e.message);
    console.error(lines.slice(Math.max(0, ln - 3), ln + 2).join('\n'));
  } else console.error(e.stack);
  process.exit(1);
}
