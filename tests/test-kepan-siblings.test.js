/**
 * 一行多個同層終端科共用一段文（v4.27.15）：
 *   「辛一重舉標簡；辛二、顯成大性」「壬一發問時 壬二能問者 壬三發問處 壬四所問人」
 * 拆成同層並列的科，行號相同；一般標題不誤切。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kepan.js');
const UI = require('../kepan-sidebar.js');

const labels = l => K.parseHeadingSegments(l).map(s => s.ch + s.num + s.title);

describe('同行並列的終端科', () => {
  test('分號分隔（有無頓號）', () => {
    assert.deepEqual(labels('### 辛一重舉標簡；辛二、顯成大性'), ['辛1重舉標簡', '辛2顯成大性']);
    assert.deepEqual(labels('### 辛一、重舉標簡；辛二顯成大性'), ['辛1重舉標簡', '辛2顯成大性']);
    assert.deepEqual(labels('### 辛一、重舉標簡;辛二、顯成大性'), ['辛1重舉標簡', '辛2顯成大性']);
  });
  test('空白分隔的四科', () => {
    assert.deepEqual(labels('#### 壬一發問時 壬二能問者 壬三發問處 壬四所問人'),
      ['壬1發問時', '壬2能問者', '壬3發問處', '壬4所問人']);
  });
  test('不誤切：分號後不是科判標號就維持原行為（長句不成科）', () => {
    assert.deepEqual(labels('### 辛一、說明；是故說之'), []);
    assert.deepEqual(labels('### 辛一、標；講解如下'), []);
    assert.deepEqual(labels('## 甲一、本地分（分二科）  乙一、略辨地名'), ['甲1本地分', '乙1略辨地名']);
  });
  test('建樹：並列科同層、同父、同行號；後續子科掛在最後一科', () => {
    const body = ['## 庚一、總標', '### 辛一重舉標簡；辛二、顯成大性', '#### 壬一、發問時', '## 庚二、別釋'].join('\n');
    const t = K.buildKepanTree([{ name: 'a', text: body }]);
    const by = m => t.nodes.find(n => n.m === m);
    const a = by('辛一'), b = by('辛二');
    assert.equal(a.p, by('庚一').id);
    assert.equal(b.p, a.p);
    assert.equal(a.d, b.d);
    assert.equal(a.l, b.l);
    assert.equal(by('壬一').p, b.id);
    assert.equal(t.problems.length, 0);
    assert.deepEqual(t.heads[0].map(h => h[1]), [by('庚一').id, b.id, by('壬一').id, by('庚二').id]);
  });
  test('建樹：四個並列科', () => {
    const t = K.buildKepanTree([{ name: 'a', text: '## 辛一、總\n#### 壬一發問時 壬二能問者 壬三發問處 壬四所問人\n' }]);
    const ks = t.nodes.filter(n => n.m.startsWith('壬'));
    assert.equal(ks.length, 4);
    assert.equal(new Set(ks.map(n => n.p)).size, 1);
    assert.equal(new Set(ks.map(n => n.l)).size, 1);
  });
  test('閱讀框階梯：用戶端 headingSegments 也依分號拆開', () => {
    const segs = UI.headingSegments('辛一重舉標簡；辛二、顯成大性');
    assert.deepEqual(segs.map(s => s.mark + s.title), ['辛一重舉標簡', '辛二顯成大性']);
  });
});
