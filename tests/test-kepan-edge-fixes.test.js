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
