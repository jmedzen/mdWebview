'use strict';
// 前端 JS 語法檢查：版本號替換若沒跳脫小數點，可能把程式裡的數字（如 14,16,17）改壞，
// 整支檔案載入失敗（v4.16.2 起 vendor/pele 就因此壞掉，流程圖全站不顯示）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = [
  ...fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, f)),
  ...jsFiles(path.join(ROOT, 'vendor')),
  ...jsFiles(path.join(ROOT, 'i18n')),
];

test('所有前端與 vendor JS 都能通過語法檢查', () => {
  const bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad.push(path.relative(ROOT, f) + ': ' + String(e.stderr).split('\n').find(l => /Error/.test(l))); }
  }
  assert.deepStrictEqual(bad, []);
});

test('vendor/pele 的 token 表沒有被版本號替換改壞', () => {
  const src = fs.readFileSync(path.join(ROOT, 'vendor/pele/pele.global.js'), 'utf8');
  assert.ok(!src.includes('14.16.'), 'pele 內有 14.16.x 這種被改壞的數字');
  assert.strictEqual((src.match(/12,14,16,17,19/g) || []).length, 2);
});
