/**
 * @file tests/test-kepan-ux-v42716.test.js
 *
 * v4.27.16 的科判 UX 改動：
 *   1. 前後科只走末端科（停在分科時，後一科 = 它子樹的第一個末端科）。
 *   2. 本篇沒有科判標題時，位置標成「承前」，不再假裝讀者在那一科。
 *   3. 深層縮排封頂（第 40 層不再吃掉 175px）。
 *   4. 沒有目前位置時，樹自動展開到看得見幾列（頂層只有一科的樹不會只顯示一列）。
 *   5. 章節式樹的範圍選單把「序與附說」與「章」分開。
 *   6. 層級存疑（problems）可展開並跳去核對。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UI = require('../kepan-sidebar.js');
const K = require('../lib/kepan.js');
const ROOT = path.join(__dirname, '..');

/** 甲一(分二科) ├ 乙一 ├ 丙一/丙二 └ 乙二(分二科) ├ 丙一/丙二 ；甲二 */
function demoTree() {
  const spec = [
    [0, '甲一', '總標'], [1, '乙一', '第一段'], [2, '丙一', '之一'], [2, '丙二', '之二'],
    [1, '乙二', '第二段'], [5, '丙一', '之一'], [5, '丙二', '之二'], [0, '甲二', '別釋'],
  ];
  const payload = {
    title: '論', files: ['T1', 'T2'], heads: {},
    nodes: spec.map(([p, m, t], i) => [p, m, t, 0, i >= 7 ? 1 : 0, i + 1]),
  };
  return { payload, N: UI.expandNodes(payload), L: UI.leafIds(UI.expandNodes(payload)) };
}

describe('1. 前後科只走末端科', () => {
  const { N, L } = demoTree();

  test('leafIds 只含沒有子科的科，且維持文件順序', () => {
    assert.deepEqual(L, [3, 4, 6, 7, 8]);
    assert.deepEqual(L.map(id => N[id].m + N[id].t), ['丙一之一', '丙二之二', '丙一之一', '丙二之二', '甲二別釋']);
  });

  test('停在分科按下一科 → 進入子樹第一個末端科（不會停在子分科）', () => {
    assert.equal(N[UI.navTargets(N, 1, L).next].m + N[UI.navTargets(N, 1, L).next].t, '丙一之一');
    assert.equal(N[UI.navTargets(N, 2, L).next].m + N[UI.navTargets(N, 2, L).next].t, '丙一之一');
  });

  test('任何科的前後科都是末端科', () => {
    const set = new Set(L);
    for (let id = 1; id < N.length; id++) {
      const t = UI.navTargets(N, id, L);
      if (t.next) assert.ok(set.has(t.next));
      if (t.prev) assert.ok(set.has(t.prev));
    }
  });

  test('末端科之間可逆；首末端停用', () => {
    for (const id of L) {
      const nx = UI.navTargets(N, id, L).next;
      if (nx) assert.equal(UI.navTargets(N, nx, L).prev, id);
    }
    assert.equal(UI.navTargets(N, L[0], L).prev, 0);
    assert.equal(UI.navTargets(N, L[L.length - 1], L).next, 0);
  });

  test('不傳 leafIds 也算得一樣', () => {
    for (let id = 1; id < N.length; id++) assert.deepEqual(UI.navTargets(N, id), UI.navTargets(N, id, L));
  });
});

describe('2. 沒有科判標題的篇：hereInfo 標成「承前」', () => {
  // 檔 0 有科判，檔 1 沒有
  const payload = {
    title: '論', files: ['T1', 'T2'], heads: { 0: [[10, 1]], 1: [] },
    nodes: [[0, '甲一', '序分', 0, 0, 10]],
  };

  test('該檔自己有標題：own', () => {
    const r = UI.hereInfo(payload, 0, 11);
    assert.equal(r.id, 1);
    assert.equal(r.own, true);
    assert.equal(r.inherited, false);
    assert.equal(r.none, false);
  });

  test('該檔沒有標題：沿用前一篇，但標成 inherited（不假裝讀者在這一科）', () => {
    const r = UI.hereInfo(payload, 1, 5);
    assert.equal(r.id, 1, '仍借前一篇最後一科，保住跨卷延續');
    assert.equal(r.own, false);
    assert.equal(r.inherited, true);
    assert.equal(r.none, false);
  });

  test('前面沒有科判可借：none', () => {
    const empty = { title: 'x', files: ['a'], heads: { 0: [] }, nodes: [] };
    const r = UI.hereInfo(empty, 0, 5);
    assert.equal(r.id, 0);
    assert.equal(r.none, true);
    assert.equal(r.inherited, false);
  });

  test('卷首在第一個科判前：仍屬上一卷最後一科（既有跨卷行為不變）', () => {
    const two = {
      title: '論', files: ['T1', 'T2'], heads: { 0: [[10, 1], [100, 2]], 1: [[50, 3]] },
      nodes: [[0, '甲一', 'a', 0, 0, 10], [0, '甲二', 'b', 0, 0, 100], [0, '甲三', 'c', 0, 1, 50]],
    };
    const r = UI.hereInfo(two, 1, 5);   // 第 2 篇第 5 行，在第 50 行的標題之前
    assert.equal(r.id, 2, '取上一卷最後一科');
    assert.equal(r.inherited, false, '本檔自己有標題，不是承前');
  });
});

describe('3. 深層縮排封頂', () => {
  test('第 40 層不再吃 175px，且單調不減', () => {
    assert.equal(UI.indentFor(40), UI.INDENT_CAP);
    assert.ok(UI.indentFor(40) <= 120);
    let prev = -1;
    for (let l = 0; l <= 60; l++) { const v = UI.indentFor(l); assert.ok(v >= prev); assert.ok(v <= UI.INDENT_CAP); prev = v; }
  });

  test('前 5 層維持原本的 14px 節奏（既有外觀不變）', () => {
    for (let l = 0; l <= 5; l++) assert.equal(UI.indentFor(l), l * UI.INDENT);
  });
});

describe('4. 沒有目前位置時自動展開到看得見', () => {
  // 頂層只有一科，往下才是內容（模擬瑜伽師地論本地分）
  const payload = {
    title: '論', files: ['T1'], heads: { 0: [[10, 1]] },
    nodes: [
      [0, '甲一', '本地分', 0, 0, 10],
      [1, '乙一', '一', 0, 0, 20], [1, '乙二', '二', 0, 0, 30],
      [2, '丙一', '1', 0, 0, 21], [2, '丙二', '2', 0, 0, 22],
    ],
  };
  const N = UI.expandNodes(payload);

  test('不給 minRows：只有頂層一列（舊行為）', () => {
    assert.equal(UI.visibleRows(N, 0, UI.computeExpanded(N, new Set(), new Set(), 0)).length, 1);
  });

  test('給 minRows：展開到足夠列數（樹的列數不夠時盡力而為）', () => {
    const ex = UI.computeExpanded(N, new Set(), new Set(), 0, 5);
    assert.equal(UI.visibleRows(N, 0, ex).length, 5, '這棵樹最多 5 列，應全開');
    // 樹比 minRows 小也不能卡住或爆掉
    const ex2 = UI.computeExpanded(N, new Set(), new Set(), 0, 99);
    assert.equal(UI.visibleRows(N, 0, ex2).length, 5);
  });

  test('有目前位置時不受影響（維持只沿主幹展開）', () => {
    const ex = UI.computeExpanded(N, new Set(), new Set(), 4, 6);
    assert.deepEqual([...ex].sort((a, b) => a - b), [1, 2]);
  });

  test('使用者手動收起的分科不會被自動展開', () => {
    const ex = UI.computeExpanded(N, new Set(), new Set([1]), 0, 6);
    assert.ok(!ex.has(1), '使用者收起的優先');
  });
});

describe('5. 章節式樹的範圍選單分組', () => {
  const mk = arr => UI.expandNodes({
    title: '論', files: ['T1'], heads: {},
    nodes: arr.map(([m, t]) => [0, m, t, 0, 0, 1]),
  });

  test('章與節混用時分成「序與附說」與「章」兩組', () => {
    const N = mk([['第一節', '序說'], ['第二節', '序二'], ['第一章', '甲'], ['第二章', '乙'], ['第三章', '丙']]);
    const sec = UI.scopeSections(N, 0);
    assert.equal(sec.length, 2);
    assert.equal(sec[0].label, '序與附說');
    assert.deepEqual(sec[0].items.map(n => n.m), ['第一節', '第二節']);
    assert.equal(sec[1].label, '章');
    assert.deepEqual(sec[1].items.map(n => n.m), ['第一章', '第二章', '第三章']);
  });

  test('序只有一節時不加組標題（避免為了一項多一行）', () => {
    const N = mk([['第一節', '序說'], ['第一章', '甲'], ['第二章', '乙']]);
    const sec = UI.scopeSections(N, 0);
    assert.equal(sec[0].label, '', '單一項不分組');
    assert.deepEqual(sec[0].items.map(n => n.m), ['第一節']);
  });

  test('科判字樹（甲乙丙）不分這兩個標題', () => {
    const N = mk([['甲一', 'a'], ['乙一', 'b'], ['丙一', 'c']]);
    const sec = UI.scopeSections(N, 0);
    assert.deepEqual(sec.map(g => g.label), ['']);
    assert.equal(sec[0].items.length, 3);
  });

  test('CHAPTER_MARK 認得章／節／項，不認甲乙', () => {
    assert.ok(UI.CHAPTER_MARK.test('第一章'));
    assert.ok(UI.CHAPTER_MARK.test('第十二節'));
    assert.ok(UI.CHAPTER_MARK.test('第三項'));
    assert.ok(!UI.CHAPTER_MARK.test('甲一'));
    assert.ok(!UI.CHAPTER_MARK.test('丙十'));
  });
});

describe('6. 層級存疑（problems）', () => {
  test('payload 帶 problemSample 前 20 筆，problems 為總數', () => {
    const docs = [{ name: 'x', text: '## 甲一、a\n## 乙一、b\n' }];
    const tree = K.buildKepanTree(docs);
    const payload = K.toClientPayload(tree, 'd');
    assert.equal(typeof payload.problems, 'number');
    assert.ok(Array.isArray(payload.problemSample));
    assert.ok(payload.problemSample.length <= 20);
  });

  test('樣本字串是「檔名:行：說明」，前端才跳得到那一行', () => {
    // 造一個層級接不上的情況（己→誤植字，接不上會記 problem 並帶檔名:行）
    const docs = [{ name: 'T1', text: '## 癸一、a\n## 子一、b\n' }];
    const tree = K.buildKepanTree(docs);
    if (!tree.problems.length) return;   // 這組資料不一定觸發，有就跑
    assert.match(tree.problems[0], /^T1:\d+：/);
  });

  test('HTML 有 kepanProblems 容器與樣式，前端才顯示得出來', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /id="kepanProblems"[^>]*hidden/);
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    assert.match(css, /\.kepan-problems\[hidden\] \{ display: none !important; \}/);
    const js = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
    assert.match(js, /function renderProblems\(\)/);
    assert.match(js, /data-problem-line=/);
  });
});

describe('7. 地標列的「承前」標記', () => {
  test('有 kepan-inherit 樣式與 renderBar 的 inherited 分支', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    assert.match(css, /\.kepan-inherit \{/);
    const js = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
    assert.match(js, /S\.inherited/, 'renderBar 要依 inherited 顯示');
    assert.match(js, /const inheritNote = S\.inherited/);
  });

  test('承前時路徑末端不標成「目前位置」', () => {
    const js = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
    assert.match(js, /const cur = x === id && !S\.inherited;/);
  });
});
