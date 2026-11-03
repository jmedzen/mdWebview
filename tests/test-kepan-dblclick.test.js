/**
 * 科判側欄雙擊展開／收合（v4.26.0）：
 *   - makeTapGate：單擊延遲生效、同一列第二下算雙擊（不跳轉）、點別列時前一列立即跳轉
 *   - 接線（靜態檢查）：+/− 鈕與末端科立即反應、鍵盤 click（detail 0）不等、列不選字不縮放
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const KS = require('../kepan-sidebar.js');

function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    set(f, ms) { const h = ++seq; q.set(h, { at: now + ms, f }); return h; },
    clear(h) { q.delete(h); },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...q].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { q.delete(h); t.f(); }
    },
    get size() { return q.size; },
  };
}

describe('makeTapGate', () => {
  test('單擊：等 delay 後才跳轉，只跳一次', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(KS.DOUBLE_TAP_MS, T);
    assert.equal(g.tap(5, id => log.push('go' + id), id => log.push('tg' + id)), 'pending');
    T.advance(KS.DOUBLE_TAP_MS - 1);
    assert.deepEqual(log, []);
    T.advance(1);
    assert.deepEqual(log, ['go5']);
    T.advance(1000);
    assert.deepEqual(log, ['go5']);
  });

  test('雙擊：只切換展開／收合，不跳轉', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(260, T);
    const go = id => log.push('go' + id), tg = id => log.push('tg' + id);
    g.tap(5, go, tg);
    T.advance(120);
    assert.equal(g.tap(5, go, tg), 'double');
    T.advance(1000);
    assert.deepEqual(log, ['tg5']);
    assert.equal(T.size, 0);
  });

  test('連點四下 = 兩次雙擊（展開再收合）', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(260, T);
    const go = id => log.push('go' + id), tg = id => log.push('tg' + id);
    for (let i = 0; i < 4; i++) { g.tap(3, go, tg); T.advance(80); }
    T.advance(1000);
    assert.deepEqual(log, ['tg3', 'tg3']);
  });

  test('兩下間隔超過 delay：兩次單擊', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(260, T);
    const go = id => log.push('go' + id), tg = id => log.push('tg' + id);
    g.tap(5, go, tg); T.advance(300);
    g.tap(5, go, tg); T.advance(300);
    assert.deepEqual(log, ['go5', 'go5']);
  });

  test('點別列：前一列待決的單擊立即生效，不算雙擊', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(260, T);
    const go = id => log.push('go' + id), tg = id => log.push('tg' + id);
    g.tap(5, go, tg); T.advance(50);
    g.tap(6, go, tg);
    assert.deepEqual(log, ['go5']);
    T.advance(300);
    assert.deepEqual(log, ['go5', 'go6']);
  });

  test('flush 立即執行待決單擊；cancel 丟棄', () => {
    const T = fakeTimers(), log = [];
    const g = KS.makeTapGate(260, T);
    const go = id => log.push('go' + id), tg = id => log.push('tg' + id);
    g.tap(1, go, tg);
    assert.equal(g.pendingKey, 1);
    g.flush();
    assert.deepEqual(log, ['go1']);
    assert.equal(g.pendingKey, null);
    g.tap(2, go, tg);
    g.cancel();
    T.advance(1000);
    assert.deepEqual(log, ['go1']);
    g.flush();
    assert.deepEqual(log, ['go1']);
  });
});

describe('接線', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'kepan-sidebar.js'), 'utf-8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf-8');

  test('側欄點擊經過 tap gate；+/− 鈕、末端科、鍵盤 click 不等', () => {
    assert.match(src, /const gate = makeTapGate\(DOUBLE_TAP_MS\)/);
    assert.match(src, /\[data-toggle\]'\)\) \{ gate\.cancel\(\); toggle\(id\); return; \}/);
    assert.match(src, /!S\.N\[id\]\.k\.length \|\| e\.detail === 0\) \{ gate\.flush\(\); goTo\(id\); return; \}/);
    assert.match(src, /gate\.tap\(id, goTo, toggle\)/);
  });

  test('雙擊時不選字；有子科的列提示可雙擊', () => {
    assert.match(src, /e\.detail > 1 && e\.target\.closest\('\.kepan-row'\)\) e\.preventDefault\(\)/);
    assert.match(src, /雙擊\$\{open \? '收合' : '展開'\}/);
    const rule = css.slice(css.indexOf('.kepan-row {'), css.indexOf('}', css.indexOf('.kepan-row {')));
    assert.match(rule, /user-select: none/);
    assert.match(rule, /touch-action: manipulation/);
  });
});
