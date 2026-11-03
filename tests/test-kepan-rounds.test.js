/**
 * 科判多講輪（v4.25.0）：
 *   - frontmatter round 分組、總目錄 kepan: true/false/per-file、單篇 kepan: false
 *   - 各輪另講對照（完整路徑與「上一科＋本科」短鍵）
 *   - 單篇從中間層講起（丙一開頭）不記誤植
 *   - 章節式標題（第一章／第一節／第一項／甲、／一、）
 *   - kepan-sidebar.js 的講輪純函式與接線
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require('../lib/kepan.js');
const UI = require('../kepan-sidebar.js');
const ROOT = path.join(__dirname, '..');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-kepan-rounds-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function fm(obj) {
  return '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`).join('\n') + '\n---\n';
}
function write(dir, name, front, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.md'), (front ? fm(front) : '') + body);
}

/** 一個「甲一…乙一…丙一」的科判，subs 個乙、每個乙 leaves 個丙。prefix 讓兩輪的科名可以一樣或不一樣。 */
function kepanBody(subs, leaves, prefix = '') {
  const cn = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let out = `## 甲一、${prefix}總說（分${cn[subs]}科）\n\n文。\n\n`;
  for (let i = 1; i <= subs; i++) {
    out += `### 乙${cn[i]}、${prefix}第${cn[i]}段\n\n文。\n\n`;
    for (let j = 1; j <= leaves; j++) out += `#### 丙${cn[j]}、${prefix}第${cn[i]}段之${cn[j]}\n\n文。\n\n`;
  }
  return out;
}

describe('lib/kepan.js：講輪分組與 kepan 開關', () => {
  const root = path.join(tmpRoot, 'vault');
  before(() => {
    // 兩輪同一部經：A 輪兩篇、B 輪一篇，科判相同；導讀沒有 round
    const d = path.join(root, '某經');
    write(d, '0某經_總目錄', { title: '某經 總目錄', kepan: true }, '- [[講記A1]]\n- [[講記A2]]\n- [[講記B]]\n- [[導讀]]\n');
    write(d, '講記A1', { title: 'A1', round: '1996 法雲寺' }, kepanBody(2, 2));
    write(d, '講記A2', { title: 'A2', round: '1996 法雲寺' }, '#### 丙三、第二段之三\n\n文。\n');
    write(d, '講記B', { title: 'B', round: '2002 台北' }, kepanBody(2, 2));
    write(d, '導讀', { title: '導讀' }, '# 導讀\n\n沒有科判。\n');
    // 合輯：每篇一棵樹
    const c = path.join(root, '合輯');
    write(c, '0合輯_總目錄', { title: '合輯', kepan: 'per-file' }, '- [[甲篇]]\n- [[乙篇]]\n');
    write(c, '甲篇', { title: '甲篇' }, kepanBody(2, 2, '甲'));
    write(c, '乙篇', { title: '乙篇' }, kepanBody(2, 2, '乙'));
    // kepan: false 的資料夾：科再多也不顯示
    const off = path.join(root, '關閉');
    write(off, '0關閉_總目錄', { title: '關閉', kepan: false }, '');
    write(off, '長篇', { title: '長篇' }, kepanBody(5, 8));
    // 沒寫 kepan、也沒寫 round：舊行為（自動判定 ≥ 30 科，整個資料夾一棵樹）
    const auto = path.join(root, '自動');
    write(auto, '一', { title: '一' }, kepanBody(4, 8));
    write(auto, '二', { title: '二' }, '#### 丙九、第四段之九\n\n文。\n');
    write(auto, '原文', { title: '原文', kepan: false }, kepanBody(3, 5, '原文'));
    const few = path.join(root, '太少');
    write(few, '短篇', { title: '短篇' }, kepanBody(2, 2));
    K.clearKepanCache();
  });

  test('kepanFlag 讀 true／false／per-file，其餘為 undefined', () => {
    assert.equal(K.kepanFlag('true'), true);
    assert.equal(K.kepanFlag('false'), false);
    assert.equal(K.kepanFlag('per-file'), 'per-file');
    assert.equal(K.kepanFlag(undefined), undefined);
    assert.equal(K.kepanFlag('maybe'), undefined);
  });

  test('同 round 的檔案同一棵樹；不同 round 各一棵；講輪清單與目前輪次', async () => {
    const a1 = await K.getKepanForFile(root, '某經/講記A1.md');
    const a2 = await K.getKepanForFile(root, '某經/講記A2.md');
    const b = await K.getKepanForFile(root, '某經/講記B.md');
    assert.equal(a1, a2, '同一輪回傳同一份');
    assert.notEqual(a1, b);
    assert.deepEqual(a1.files, ['講記A1', '講記A2']);
    assert.deepEqual(b.files, ['講記B']);
    assert.equal(a1.round, '1996 法雲寺');
    assert.equal(a1.key, '某經#1996 法雲寺');
    assert.deepEqual(a1.rounds.map(r => [r.label, r.file]), [['1996 法雲寺', '講記A1'], ['2002 台北', '講記B']]);
    assert.equal(a1.roundIndex, 0);
    assert.equal(b.roundIndex, 1);
    assert.equal(a1.title, '某經・1996 法雲寺');
    // 跨卷接續：A2 的丙三接在 A1 的乙二之下
    const last = a1.nodes[a1.nodes.length - 1];
    assert.equal(last[1], '丙三');
    assert.equal(a1.nodes[last[0] - 1][1], '乙二');
  });

  test('沒寫 round 的篇不在任何樹；總目錄顯示第一輪', async () => {
    assert.equal(await K.getKepanForFile(root, '某經/導讀.md'), null);
    const toc = await K.getKepanForFile(root, '某經/0某經_總目錄.md');
    assert.equal(toc.round, '1996 法雲寺');
  });

  test('另講：兩輪科名相同的科互相連到對方的檔名與行號', async () => {
    const a = await K.getKepanForFile(root, '某經/講記A1.md');
    const b = await K.getKepanForFile(root, '某經/講記B.md');
    const total = 1 + 2 + 2 * 2;
    assert.equal(Object.keys(b.alt).length, total, 'B 輪每一科都對得上');
    const [ri, file, line, id] = b.alt[1][0];
    assert.equal(ri, 0);
    assert.equal(file, '講記A1');
    assert.equal(a.nodes[id - 1][2], '總說');
    assert.equal(line, a.nodes[id - 1][5]);
  });

  test('per-file：每篇一棵樹，彼此沒有講輪與對照', async () => {
    const x = await K.getKepanForFile(root, '合輯/甲篇.md');
    const y = await K.getKepanForFile(root, '合輯/乙篇.md');
    assert.notEqual(x, y);
    assert.deepEqual(x.files, ['甲篇']);
    assert.equal(x.title, '甲篇');
    assert.equal(x.key, '合輯#甲篇');
    assert.equal(x.rounds, undefined);
    assert.equal(x.alt, undefined);
    assert.equal(await K.getKepanForFile(root, '合輯/0合輯_總目錄.md'), null);
  });

  test('kepan: false 的資料夾不顯示；單篇 kepan: false 不算進樹', async () => {
    assert.equal(await K.getKepanForFile(root, '關閉/長篇.md'), null);
    const p = await K.getKepanForFile(root, '自動/一.md');
    assert.ok(p);
    assert.deepEqual(p.files, ['一', '二']);
    assert.equal(p.key, '自動');
    assert.equal(p.rounds, undefined);
    assert.equal(await K.getKepanForFile(root, '自動/原文.md'), null);
  });

  test('沒寫 kepan 時仍要 ≥ 30 科；寫 kepan: true 時 5 科就夠', async () => {
    assert.equal(await K.getKepanForFile(root, '太少/短篇.md'), null);
    assert.ok(K.MIN_NODES_FORCED < K.MIN_NODES);
  });
});

describe('lib/kepan.js：對照鍵與單篇從中間層講起', () => {
  test('從丙一開始的講記：上層以虛擬根補齊，不記誤植', () => {
    const t = K.buildKepanTree([{ name: 'x', text: '## 丙一、甲\n## 丁一、甲之一\n## 丁二、甲之二\n## 丙二、乙\n## 乙二、上層\n' }]);
    assert.equal(t.problems.length, 0, t.problems.join('\n'));
    assert.deepEqual(t.nodes.slice(1).map(n => [n.m, n.p, n.d]), [['丙一', 0, 0], ['丁一', 1, 1], ['丁二', 1, 1], ['丙二', 0, 0], ['乙二', 0, 0]]);
  });

  test('對照比科名：括號補充、「分N科」與句尾科數不影響；科判字誤植也對得上', () => {
    const r1 = K.buildKepanTree([{ name: 'a', text: '## 甲一、序分(分二科)\n## 乙一、通序\n## 乙二、別序\n## 甲一、正宗分(分四科)\n## 乙一、善現讚請\n' }]);
    const r2 = K.buildKepanTree([{ name: 'b', text: '## 甲一  序分二\n## 乙一  通序\n## 乙二　別序（發起序）\n## 甲二　正宗分四\n## 乙一　善現讚請\n' }]);
    const [a1] = K.linkRounds([{ tree: r1 }, { tree: r2 }]);
    const titles = Object.keys(a1).map(id => r1.nodes[id].t);
    assert.deepEqual(titles, ['序分(分二科)', '通序', '別序', '正宗分(分四科)', '善現讚請']);
  });

  test('開頭分法不同：「上一科＋本科」在兩輪都只出現一次時也對得上', () => {
    const r1 = K.buildKepanTree([{ name: 'a', text: '## 甲一、正宗分\n## 乙一、攝住處\n## 丙一、發心\n' }]);
    const r2 = K.buildKepanTree([{ name: 'b', text: '## 丙一、攝住處\n## 丁一、發心\n' }]);
    const [a1] = K.linkRounds([{ tree: r1 }, { tree: r2 }]);
    const id = r1.nodes.findIndex(n => n.t === '發心');
    assert.ok(a1[id], '發心應對得上');
    assert.equal(r2.nodes[a1[id][0][3]].t, '發心');
  });
});

describe('lib/kepan.js：章節式標題', () => {
  const text = [
    '---', 'title: "第一章"', '---',
    '# 攝大乘論．第一章 序說',
    '## 第01堂',
    '## 第一章、序說',
    '### 第一節、成立大乘是佛說',
    '#### 第一項、略標',
    '#### 第二項、顯大乘殊勝',
    '### 第二節、攝大乘',
    '## 第二章、所知依',
    '### 第一節、從聖教中安立阿賴耶識',
    '#### 第一項、釋名',
    '#### 甲、阿賴耶教',
    '#### 一、引經證',
    '#### 二、釋名義',
    '#### 乙、阿陀那教',
    '#### 第二項、遮異釋',
  ].join('\n');

  test('parseChapterHeading：章／節／項／甲、／一、依序為 0–4 位階；一般標題不是', () => {
    assert.deepEqual(K.parseChapterHeading('## 第一章、序說'), { rank: 0, m: '第一章', n: 1, t: '序說' });
    assert.equal(K.parseChapterHeading('### 第十二節 結說').rank, 1);
    assert.equal(K.parseChapterHeading('#### 第三項、顯大乘是佛說').rank, 2);
    assert.deepEqual(K.parseChapterHeading('#### 乙、阿陀那教'), { rank: 3, m: '乙', n: 2, t: '阿陀那教' });
    assert.equal(K.parseChapterHeading('#### 二、釋名義').rank, 4);
    assert.equal(K.parseChapterHeading('## 第01堂'), null);
    assert.equal(K.parseChapterHeading('# 攝大乘論．第一章 序說'), null);
    assert.equal(K.parseChapterHeading('正文 第一章'), null);
  });

  test('章節式講記自動改用章節建樹；位階低的接在最近的位階高者之下', () => {
    const t = K.buildKepanTree([{ name: '01章', text }]);
    assert.equal(t.chapters, true);
    const show = t.nodes.slice(1).map(n => '  '.repeat(n.d) + n.m + ' ' + n.t);
    assert.deepEqual(show, [
      '第一章 序說',
      '  第一節 成立大乘是佛說',
      '    第一項 略標',
      '    第二項 顯大乘殊勝',
      '  第二節 攝大乘',
      '第二章 所知依',
      '  第一節 從聖教中安立阿賴耶識',
      '    第一項 釋名',
      '      甲 阿賴耶教',
      '        一 引經證',
      '        二 釋名義',
      '      乙 阿陀那教',
      '    第二項 遮異釋',
    ]);
    // 行號含 frontmatter；heads 記每個章節標題
    assert.equal(t.nodes[1].l, 6);
    assert.equal(t.heads[0].length, 13);
    const p = K.toClientPayload(t, 'x');
    assert.equal(p.chapters, true);
  });

  test('甲乙科判的講記不會誤用章節建樹', () => {
    assert.equal(K.usesChapters([{ name: 'a', text: kepanBody(3, 3) }]), false);
  });

  test('pickScopeDepth：最淺而至少 4 科的一層，最深丙層', () => {
    const mk = counts => {
      const nodes = [{ d: -1 }];
      counts.forEach((c, d) => { for (let i = 0; i < c; i++) nodes.push({ d }); });
      return nodes;
    };
    assert.equal(K.pickScopeDepth(mk([10])), 0);
    assert.equal(K.pickScopeDepth(mk([1, 6])), 1);
    assert.equal(K.pickScopeDepth(mk([1, 2, 17])), 2);
    assert.equal(K.pickScopeDepth(mk([1, 2, 2, 50])), 2);
  });
});

describe('kepan-sidebar.js：講輪', () => {
  const payload = {
    title: 't', files: ['a'], heads: {},
    nodes: [[0, '甲一', '總', 0, 0, 5], [1, '乙一', '分', 0, 0, 9], [2, '丙一', '細', 0, 0, 12]],
    rounds: [{ label: 'A', file: 'a', n: 3 }, { label: 'B', file: 'b', n: 3 }],
    roundIndex: 0,
    alt: { 2: [[1, 'b', 40, 7]] },
  };
  const N = UI.expandNodes(payload);

  test('altFor：本科沒有對照時用最近有對照的上層', () => {
    assert.deepEqual(UI.altFor(payload, N, 2), { id: 2, hits: [[1, 'b', 40, 7]] });
    assert.deepEqual(UI.altFor(payload, N, 3), { id: 2, hits: [[1, 'b', 40, 7]] });
    assert.equal(UI.altFor(payload, N, 1), null);
    assert.equal(UI.altFor({ nodes: [] }, N, 1), null);
  });

  test('roundTarget：有對照就到另一輪的同一科，否則到該輪第一篇', () => {
    assert.deepEqual(UI.roundTarget(payload, N, 3, 1), { file: 'b', line: 40, id: 7 });
    assert.deepEqual(UI.roundTarget(payload, N, 1, 1), { file: 'b', line: 0, id: 0 });
  });

  test('scopeOf 可指定範圍層級（章節式為 0）', () => {
    assert.equal(UI.scopeOf(N, 3, 0), 1);
    assert.equal(UI.scopeOf(N, 3, 1), 2);
    assert.equal(UI.scopeOf(N, 3), 3);
  });

  test('接線：index.html 有講輪切換區；樣式與另講連結', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /id="kepanRounds"[^>]*hidden/);
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    assert.match(css, /\.kepan-round\.is-current \{[^}]*var\(--accent\)[^}]*color: var\(--bg-primary\)/);
    assert.match(css, /\.kepan-alt a \{[^}]*var\(--accent\)/);
    const js = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
    assert.match(js, /data-alt-round/);
    assert.match(js, /if \(S\.payload\.chapters\) return;/, '章節式標題不改繪');
  });
});
