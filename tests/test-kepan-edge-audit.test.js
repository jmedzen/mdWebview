/**
 * 科判 edge case 審計（v4.27.17）：
 *   - 長科名／科名後接長括號不再被丟掉（維摩詰「室內說法明引接攝受（分三科）（從〈問疾品〉…）」）
 *   - 講解文字（有逗號句號）仍不成科
 *   - 閱讀框改繪階梯與伺服器用同一組層級字，科名裡「說 法一 事」不誤切
 *   - 前端：沒有目前科時清掉上一篇的地標列；暫時性失敗不記成「沒有科判」
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../lib/kepan.js');
const UI = require('../kepan-sidebar.js');

const labels = l => K.parseHeadingSegments(l).map(s => s.ch + s.num + s.title);

describe('科名長度與括號', () => {
  test('長科名、長括號補充都成科', () => {
    assert.equal(labels('#### 乙二、正明聲益方便（淨名方便託疾興教助佛揚化令入不思議解脫除物罪垢引入四土成淨佛國之行）（分二科）').length, 1);
    assert.equal(labels('## 甲二、室內說法明引接攝受（分三科）（從〈問疾品〉至〈香積佛品〉共六品）').length, 1);
    assert.equal(labels('#### 丑二、約道品三十七法記別所解（約道品中七種觀門記別所解）（依能證行）（分三科）').length, 1);
  });
  test('短科名可含引號', () => {
    assert.deepEqual(labels('### 丙二、別明念佛「三昧」義'), ['丙2別明念佛「三昧」義']);
  });
  test('講解文字仍不成科', () => {
    assert.deepEqual(labels('### 巳二、「所以者何」，是「徵」。巳三、解「釋」'), []);
    assert.deepEqual(labels('### 丙一、隨類生，前面第一科是「除災生」，「除災生」這一科解釋完了，下面第二科是「隨類生」'), []);
    assert.deepEqual(labels('### 丁二、如理作意施設建立，這是第三大科「如理作意」。這個「如理作意」，在我們的內心上來說是沒有的'), []);
    assert.equal(K.looksLikeTitle('x'.repeat(91)), false);
  });
  test('長科名不再讓子科接錯上層', () => {
    const body = [
      '## 甲二、室內說法明引接攝受（分三科）（從〈問疾品〉至〈香積佛品〉共六品）',
      '### 乙一、問疾', '### 乙二、香積', '## 甲三、流通',
    ].join('\n');
    const t = K.buildKepanTree([{ name: 'a', text: body }]);
    const names = t.nodes.slice(1).map(n => n.m);
    assert.deepEqual(names, ['甲二', '乙一', '乙二', '甲三']);
    assert.equal(t.nodes[2].p, 1);
  });
});

describe('閱讀框階梯切分與伺服器一致', () => {
  test('科名內「空白＋非層級字＋數字」不切', () => {
    const segs = UI.headingSegments('乙二、說 法一 事');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].mark, '乙二');
    assert.equal(segs[0].title, '說 法一 事');
  });
  test('正常多科仍切開', () => {
    assert.deepEqual(UI.headingSegments('甲一、本地分（分二科）  乙一、略辨地名').map(s => s.mark), ['甲一', '乙一']);
  });
});

describe('前端：沒有目前科、暫時失敗', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'kepan-sidebar.js'), 'utf8');
  test('沒有科時 renderBar 收起地標列、後一科指向第一科', () => {
    assert.match(src, /if \(!id\) \{[\s\S]{0,200}bar\.hidden = true/);
    assert.deepEqual(UI.navTargets([{}, {}, {}], 0), { prev: 0, next: 1 });
  });
  test('spy 在沒有科時清掉 hereId', () => {
    assert.match(src, /本篇與它之前的篇都沒有科判標題/);
  });
  test('fetchPayload：失敗不記進 none', () => {
    assert.match(src, /if \(!j\.failed\) c\.none\.add\(name\)/);
  });
});
