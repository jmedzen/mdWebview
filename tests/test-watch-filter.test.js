/**
 * @file test-watch-filter.test.js
 * 索引只收 .md：附件（PDF、docx、圖片）被同步／改寫時不該觸發整庫索引重建。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isIndexRelevantChange } = require('../lib/watch-filter');

const ROOT = path.join(__dirname, '..');

test('.md 與沒有檔名的異動會觸發重建', () => {
  assert.equal(isIndexRelevantChange('/x', 'change', 'a/b.md'), true);
  assert.equal(isIndexRelevantChange('/x', 'rename', 'a/b.md'), true);
  assert.equal(isIndexRelevantChange('/x', 'change', ''), true);
  assert.equal(isIndexRelevantChange('/x', 'change', undefined), true);
});

test('非 .md 檔的 change 事件一律不觸發', () => {
  for (const f of ['z-附件/a.pdf', 'z-附件/b.docx', 'z-附件/01-首頁.png']) {
    assert.equal(isIndexRelevantChange('/x', 'change', f), false);
  }
});

test('非 .md 檔的 rename（新增／刪除）不觸發；目錄的 rename 仍觸發', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-watch-'));
  fs.mkdirSync(path.join(dir, 'v1.2'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  assert.equal(isIndexRelevantChange(dir, 'rename', 'a.pdf'), false);          // 新增／改名後存在的檔
  assert.equal(isIndexRelevantChange(dir, 'rename', 'gone.pdf'), false);       // 已刪除、有副檔名
  assert.equal(isIndexRelevantChange(dir, 'rename', 'v1.2'), true);            // 名稱含「.」的目錄
  assert.equal(isIndexRelevantChange(dir, 'rename', 'deleted-folder'), true);  // 已刪除、沒副檔名：可能是目錄
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server.js 的全庫與辭典監視器都套用這個過濾', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes('isIndexRelevantChange(mdRoot, eventType, filename)'));
  assert.ok(src.includes('isIndexRelevantChange(root, eventType, filename)'));
});
