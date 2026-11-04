/**
 * @file tests/test-kepan-single-flag.test.js
 *
 * 單篇講記 kepan: true（v4.27.16）。
 *
 * 新增條件有兩面，兩面都要顧：
 *   1. 新行為：單篇自己寫 kepan: true，科數再少（1 科也成）都當科判系列。
 *   2. 既有條件一個都不能走鐘：≥30 科自動判定、總目錄 true／per-file 的 ≥5 科、
 *      總目錄 false 硬關、單篇 false 排除、round 分輪、per-file 逐篇成樹、
 *      講輪對照、沒科判標題的篇回 nearby。
 * 所以下面每一個既有行為都獨立一條測試，任何一條被新條件影響就會亮紅燈。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require('../lib/kepan.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-kepan-single-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function fm(obj) {
  return '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`).join('\n') + '\n---\n';
}
function write(dir, name, front, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.md'), (front ? fm(front) : '') + body);
}

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 甲一（分 N 科）→ 乙一…乙N，每個乙再掛 L 個丙。總科數 = 1 + subs + subs*leaves。 */
function kepanBody(subs, leaves, prefix = '') {
  let out = `## 甲一、${prefix}總說（分${CN[subs]}科）\n\n文。\n\n`;
  for (let i = 1; i <= subs; i++) {
    out += `### 乙${CN[i]}、${prefix}第${CN[i]}段\n\n文。\n\n`;
    for (let j = 1; j <= leaves; j++) out += `#### 丙${CN[j]}、${prefix}第${CN[i]}段之${CN[j]}\n\n文。\n\n`;
  }
  return out;
}

const root = path.join(tmpRoot, 'vault');
/** 分輪的資料夾：round 不同才是不同的樹，隔離性質要在這裡驗。 */
const rounds = path.join(tmpRoot, 'rounds');
const roundsOff = path.join(tmpRoot, 'rounds-off');

before(() => {
  // ── 新條件：單篇 kepan: true ──
  write(path.join(root, '單篇開啟'), '短講記', { title: '短講記', kepan: true }, kepanBody(2, 2));        // 7 科
  write(path.join(root, '單篇極短'), '更短', { title: '更短', kepan: true }, '## 甲一、序分\n\n文。\n'); // 1 科

  // ── 既有行為：自動判定 ≥ 30 科，整個資料夾一棵樹（沒寫 round 就是一棵）──
  write(path.join(root, '自動'), '一', { title: '一' }, kepanBody(4, 8));                // 37 科
  write(path.join(root, '自動'), '二', { title: '二' }, '#### 丙九、第四段之九\n\n文。\n');
  write(path.join(root, '自動'), '短篇', { title: '短篇' }, kepanBody(2, 2));
  write(path.join(root, '自動'), '原文', { title: '原文', kepan: false }, kepanBody(3, 5, '原文'));
  const few = path.join(root, '太少');
  write(few, '短篇', { title: '短篇' }, kepanBody(2, 2));                                 // 7 科 < 30

  // ── 既有行為：總目錄 kepan: true → 門檻 5 ──
  write(path.join(root, '總目錄開'), '0總目錄', { title: '總目錄開', kepan: true },
    '- [[講記A]]\n- [[講記B]]\n- [[太短]]\n');
  write(path.join(root, '總目錄開'), '講記A', { title: 'A', round: '1996 法雲寺' }, kepanBody(2, 2));
  write(path.join(root, '總目錄開'), '講記B', { title: 'B', round: '2002 台北' }, kepanBody(2, 2));
  write(path.join(root, '總目錄開'), '太短', { title: '太短' }, '## 甲一、序分\n## 乙一、通序\n');  // 2 科

  // ── 既有行為：總目錄 kepan: false 硬關（即使單篇寫 true）──
  write(path.join(root, '總目錄關'), '0總目錄', { title: '總目錄關', kepan: false }, '');
  write(path.join(root, '總目錄關'), '長篇', { title: '長篇' }, kepanBody(5, 8));                      // 46 科
  write(path.join(root, '總目錄關'), '宣告', { title: '宣告', kepan: true }, kepanBody(2, 2));          // 新條件不能突破

  // ── 既有行為：per-file 逐篇成樹 ──
  write(path.join(root, '合輯'), '0合輯_總目錄', { title: '合輯', kepan: 'per-file' },
    '- [[甲篇]]\n- [[乙篇]]\n');
  write(path.join(root, '合輯'), '甲篇', { title: '甲篇' }, kepanBody(2, 2, '甲'));
  write(path.join(root, '合輯'), '乙篇', { title: '乙篇' }, kepanBody(2, 2, '乙'));

  // ── 分輪：宣告的那一輪 vs 沒宣告的第二輪（隔離性質）──
  write(rounds, '甲輪', { title: '甲輪', round: '第一輪' }, kepanBody(4, 8));                        // 37 科
  write(rounds, '乙輪', { title: '乙輪', round: '第二輪', kepan: true }, kepanBody(1, 2));           // 4 科
  write(roundsOff, '甲輪', { title: '甲輪', round: '第一輪' }, kepanBody(4, 8));
  write(roundsOff, '乙輪', { title: '乙輪', round: '第二輪' }, kepanBody(1, 2));

  K.clearKepanCache();
});

describe('新條件：單篇講記 kepan: true', () => {
  test('單篇 kepan: true 的短講記（7 科，遠低於 30）也開啟科判', async () => {
    const p = await K.getKepanForFile(root, '單篇開啟/短講記.md');
    assert.ok(p, '寫了 kepan: true 就該有科判樹');
    assert.equal(p.nodes.length, 7);
    assert.deepEqual(p.files, ['短講記']);
    assert.equal(p.chapters, undefined, '甲乙層級不該被誤判成章節式');
  });

  test('單篇 kepan: true 只要有 1 科就成立', async () => {
    const p = await K.getKepanForFile(root, '單篇極短/更短.md');
    assert.ok(p);
    assert.equal(p.nodes.length, 1);
    assert.equal(p.nodes[0][2], '序分');
  });

  test('門檻常數：MIN_NODES_SINGLE = 1，且嚴格小於另外兩道門檻', () => {
    assert.equal(K.MIN_NODES_SINGLE, 1);
    assert.ok(K.MIN_NODES_SINGLE < K.MIN_NODES_FORCED);
    assert.ok(K.MIN_NODES_FORCED < K.MIN_NODES);
  });

  test('單篇 kepan: true 與 kepan: false 同時存在：false 仍優先排除那一篇', async () => {
    const dir = path.join(tmpRoot, '混合');
    write(dir, '講記', { title: '講記', kepan: true }, kepanBody(2, 2));
    write(dir, '原文', { title: '原文', kepan: false }, kepanBody(2, 2, '原文'));
    K.clearKepanCache();
    const p = await K.getKepanForFile(dir, '講記.md');
    assert.ok(p);
    assert.deepEqual(p.files, ['講記']);
    assert.equal(await K.getKepanForFile(dir, '原文.md'), null);
  });
});

describe('回歸：既有條件維持不變', () => {
  test('沒寫 kepan 時仍要 ≥ 30 科（7 科的「太少/短篇」仍然關閉）', async () => {
    assert.equal(await K.getKepanForFile(root, '太少/短篇.md'), null);
  });

  test('沒寫 kepan 時 ≥ 30 科照常開啟，整個資料夾仍是一棵樹（舊行為）', async () => {
    const p = await K.getKepanForFile(root, '自動/一.md');
    assert.ok(p);
    assert.deepEqual(p.files, ['一', '二', '短篇']);
    assert.equal(p.key, '自動');
    assert.equal(p.rounds, undefined);
    // 37（甲一＋4 乙＋32 丙）＋丙九；短篇與一重複的「甲一」「乙」沿用既有科，只新增 6 科
    assert.equal(p.nodes.length, 37 + 1 + 6);
  });

  test('單篇 kepan: false 仍然排除（不因新條件而復活）', async () => {
    assert.equal(await K.getKepanForFile(root, '自動/原文.md'), null);
  });

  test('總目錄 kepan: true：≥5 科才開，2 科的「太短」仍然不給樹', async () => {
    const a = await K.getKepanForFile(root, '總目錄開/講記A.md');
    assert.ok(a);
    assert.equal(a.round, '1996 法雲寺');
    const short = await K.getKepanForFile(root, '總目錄開/太短.md');
    assert.equal(short.none, true, '只回 nearby 清單，不是一棵樹');
    assert.equal(short.others.length, 2);
  });

  test('總目錄 kepan: true 時兩輪仍各自一棵樹，另有講輪清單', async () => {
    const a = await K.getKepanForFile(root, '總目錄開/講記A.md');
    const b = await K.getKepanForFile(root, '總目錄開/講記B.md');
    assert.notEqual(a.key, b.key);
    assert.equal(a.rounds.length, 2);
    assert.equal(a.rounds[a.roundIndex].label, a.round);
    assert.equal(b.rounds[b.roundIndex].label, b.round);
  });

  test('總目錄 kepan: false 仍然硬關整個資料夾，單篇寫 kepan: true 也開不了', async () => {
    assert.equal(await K.getKepanForFile(root, '總目錄關/長篇.md'), null);
    assert.equal(await K.getKepanForFile(root, '總目錄關/宣告.md'), null, '新條件不能突破資料夾層的關閉');
  });

  test('per-file 仍然每篇一棵樹，總目錄頁自己沒有樹', async () => {
    const x = await K.getKepanForFile(root, '合輯/甲篇.md');
    const y = await K.getKepanForFile(root, '合輯/乙篇.md');
    assert.notEqual(x, y);
    assert.deepEqual(x.files, ['甲篇']);
    assert.equal(x.key, '合輯#甲篇');
    assert.equal(x.rounds, undefined);
    assert.equal(await K.getKepanForFile(root, '合輯/0合輯_總目錄.md'), null);
  });

  test('kepanFlag 的認定範圍不變：true／yes／false／no／per-file，其餘 undefined', () => {
    assert.equal(K.kepanFlag('true'), true);
    assert.equal(K.kepanFlag('yes'), true);
    assert.equal(K.kepanFlag('false'), false);
    assert.equal(K.kepanFlag('no'), false);
    assert.equal(K.kepanFlag('per-file'), 'per-file');
    assert.equal(K.kepanFlag('perfile'), 'per-file');
    assert.equal(K.kepanFlag('file'), 'per-file');
    assert.equal(K.kepanFlag('1'), undefined);
    assert.equal(K.kepanFlag('on'), undefined);
    assert.equal(K.kepanFlag(undefined), undefined);
  });

  test('沒寫 round 時仍是「整個資料夾一棵樹」，宣告會把同資料夾的篇一起帶進同一棵（既有分組語意）', async () => {
    const dir = path.join(tmpRoot, '同樹');
    write(dir, '宣告篇', { title: '宣告篇', kepan: true }, '## 甲一、序分\n\n文。\n');
    write(dir, '其他篇', { title: '其他篇' }, '# 其他\n\n沒有科判標題。\n');
    K.clearKepanCache();
    const p = await K.getKepanForFile(dir, '宣告篇.md');
    assert.ok(p);
    assert.deepEqual(p.files, ['其他篇', '宣告篇'], '沒寫 round 就是一棵樹，與舊行為一致（順自然排序）');
    assert.equal(p.nodes.length, 1);
  });
});

describe('回歸：單篇 kepan: true 與 round 分輪、nearby 的互動', () => {
  test('某輪宣告 kepan: true 時，該輪不必湊到 30 科也能成樹', async () => {
    const p = await K.getKepanForFile(rounds, '乙輪.md');
    assert.ok(p, '宣告了就不該被 round 門檻刷掉');
    assert.equal(p.round, '第二輪');
    assert.equal(p.nodes.length, 4);
  });

  test('宣告與否只影響自己那一輪：沒宣告的第一輪照舊（37 科，本來就過門檻）', async () => {
    const a = await K.getKepanForFile(rounds, '甲輪.md');
    assert.ok(a);
    assert.equal(a.round, '第一輪');
    assert.deepEqual([...a.rounds.map(r => r.label)].sort(), ['第一輪', '第二輪'].sort());
    assert.equal(a.rounds[a.roundIndex].label, a.round);
  });

  test('沒宣告的第二輪照舊被門檻刷掉，只回 nearby（既有行為，不受新條件影響）', async () => {
    const p = await K.getKepanForFile(roundsOff, '乙輪.md');
    assert.ok(p, '不是 null：回的是「本篇沒有科判標題」的 nearby 版本');
    assert.equal(p.none, true);
    assert.equal(p.others.length, 1);
    assert.equal(p.others[0].label, '第一輪');
    const a = await K.getKepanForFile(roundsOff, '甲輪.md');
    assert.equal(a.rounds, undefined, '只剩一輪時沒有講輪清單');
  });

  test('合輯（per-file）裡單篇宣告 kepan: true 只影響那一篇', async () => {
    const dir = path.join(tmpRoot, '合輯宣告');
    write(dir, '0總目錄', { title: '合輯宣告', kepan: 'per-file' }, '- [[甲篇]]\n- [[乙篇]]\n');
    write(dir, '甲篇', { title: '甲篇', kepan: true }, '## 甲一、序分\n\n文。\n');
    write(dir, '乙篇', { title: '乙篇' }, '## 甲一、序分\n\n文。\n');   // 同樣 1 科，但沒宣告
    K.clearKepanCache();
    const a = await K.getKepanForFile(dir, '甲篇.md');
    assert.ok(a, 'per-file 下宣告的短篇也成樹（1 科就夠）');
    assert.equal(a.nodes.length, 1);
    assert.deepEqual(a.files, ['甲篇'], 'per-file 每篇一棵樹');
    assert.equal(await K.getKepanForFile(dir, '乙篇.md'), null, '沒宣告的同樣 1 科卻不給樹');
  });
});
