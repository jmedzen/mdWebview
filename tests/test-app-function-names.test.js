const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// app.js is one big IIFE. Two `function foo()` declarations in that scope do not
// error: the later one silently wins everywhere. That is how the large-file
// outline's scroll spy ended up calling the read-progress `topVisibleLine()` and
// highlighting the wrong heading (v4.3.1).
test('app.js 頂層沒有重複的同名函式宣告', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const seen = new Map();
  const dups = [];
  const re = /^  (?:async )?function ([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    if (seen.has(m[1])) dups.push(`${m[1]} (L${seen.get(m[1])}, L${line})`);
    else seen.set(m[1], line);
  }
  assert.deepEqual(dups, [], '重複宣告：' + dups.join(', '));
});
