'use strict';
const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync('public/index.html', 'utf8');
const code = fs.readFileSync('public/app.js', 'utf8');
assert.match(html, /<script src="\/app\.js" defer><\/script>/, 'HTML shell must load external app.js');
try {
  new Function(code);
  console.log('Frontend JS syntax check passed, script length: ' + code.length);
} catch (e) {
  const pos = e.stack.match(/<anonymous>:(\d+):(\d+)/);
  if (pos) {
    const ln = Number(pos[1]) - 1;
    const lines = code.split('\n');
    console.error('Frontend JS syntax error at line ' + ln + ': ' + e.message);
    console.error(lines.slice(Math.max(0, ln - 3), ln + 2).join('\n'));
  } else console.error(e.stack);
  process.exit(1);
}
