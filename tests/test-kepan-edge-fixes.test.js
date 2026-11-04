'use strict';
const test = require('node:test');
const assert = require('node:assert');
const K = require('../lib/kepan.js');
const { shortTitle } = require('../kepan-sidebar.js');

const doc = (h) => `---\ntitle: x\n---\n${h.map(x => '## ' + x).join('\n')}\n`;

test('shortTitle 去掉等於子科數的尾數，其他不動', () => {
  assert.strictEqual(shortTitle('總標綱要二', 2), '總標綱要');
  assert.strictEqual(shortTitle('略辨地名2', 2), '略辨地名');
  assert.strictEqual(shortTitle('別廣地攝14', 14), '別廣地攝');
  assert.strictEqual(shortTitle('總標綱要二', 3), '總標綱要二');
  assert.strictEqual(shortTitle('總標綱要二', 0), '總標綱要二');
  assert.strictEqual(shortTitle('二', 2), '二');
  assert.strictEqual(shortTitle('序分（分二科）'), '序分');
});

test('0 標題的檔不拿整棵樹，改走 none 提示', () => {
  const texts = new Map([
    ['A', doc(['甲一、總說', '乙一、細說', '乙二、結', '乙三、尾', '丙一、甲', '丙二、乙']) ],
    ['B', '沒有任何科判標題的大意\n'],
  ]);
  texts.set('總目錄', '---\nkepan: true\n---\n[[A]] [[B]]\n');
  const by = K.buildFolder('d', texts);
  assert.ok(by.get('A').nodes, 'A 有樹');
  assert.ok(!by.get('B').nodes, 'B 沒樹');
});

test('orderFiles 容許表格內 [[檔名\\|別名]] 的反斜線', () => {
  const toc = '| [[b\\|乙]] | [[a\\|甲]] |';
  assert.deepStrictEqual(K.orderFiles(['a', 'b'], toc), ['b', 'a']);
});

test('26 本書只有 1 本有科判：其餘篇沒有任何科判提示；連結指向有標題的那一篇', () => {
  const texts = new Map();
  texts.set('a-無標題', '大意\n');
  texts.set('b-有科判', doc(['甲一、總說', '乙一、細說', '乙二、結', '乙三、尾', '丙一、甲', '丙二、乙']));
  for (const x of ['c', 'd', 'e', 'f']) texts.set(x, '別的書\n');
  texts.set('總目錄', '---\nkepan: true\n---\n');
  const by = K.buildFolder('d', texts);
  assert.ok(by.get('b-有科判').nodes);
  for (const x of ['a-無標題', 'c', 'f']) assert.strictEqual(by.get(x), undefined, x);
});

test('none 提示的連結指向第一篇有標題的檔，不是 files[0]', () => {
  const texts = new Map();
  texts.set('a-大意', '大意\n');
  texts.set('b-講記', doc(['甲一、總說', '乙一、細說', '乙二、結', '乙三、尾', '丙一、甲', '丙二、乙']));
  texts.set('c-講記', doc(['甲一、總說', '乙一、細說', '乙二、結', '乙三、尾', '丙一、甲', '丙二、乙']));
  texts.set('總目錄', '---\nkepan: true\n---\n');
  const by = K.buildFolder('d', texts);
  assert.strictEqual(by.get('a-大意').none, true);
  assert.strictEqual(by.get('a-大意').others[0].file, 'b-講記');
});
