'use strict';
/* 一次性校验：前端 JS 语法（精确定位） */
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到脚本'); process.exit(1); }
const code = m[1];
const lines = code.split('\n');
try {
  new Function(code);
  console.log('JS 语法检查通过, 脚本长度: ' + code.length);
} catch (e) {
  const pos = e.stack.match(/<anonymous>:(\d+):(\d+)/);
  if (pos) {
    const ln = Number(pos[1]) - 1; // new Function 包装多一行
    console.error('JS 语法错误 @ 第' + ln + '行: ' + e.message);
    console.error(lines.slice(Math.max(0, ln - 3), ln + 2).map((l, i) => (ln - 2 + i) + ': ' + l).join('\n'));
  } else {
    console.error(e.message);
    console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  }
  process.exit(1);
}
