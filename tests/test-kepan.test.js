/**
 * 科判側欄（v4.20.0）：
 *   - lib/kepan.js：從講記標題抽取科判樹（層級判斷、跨卷接續、誤植、行號）、資料夾快取
 *   - /api/kepan：端對端（路徑檢查、非科判資料夾、ETag）
 *   - kepan-sidebar.js：側欄的純函式（展開規則、縮排、定位）
 *   - index.html／app.js／sw.js／Dockerfile 的接線（靜態檢查）
 *
 * 必須在 require('../server.js') 之前設定環境變數（同 test-frontmatter-e2e.test.js）。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-kepan-'));
const tmpVault = path.join(tmpRoot, 'vault');
const tmpLogs = path.join(tmpRoot, 'logs');
const tmpConfig = path.join(tmpRoot, 'config.json');
fs.mkdirSync(tmpVault, { recursive: true });
fs.mkdirSync(tmpLogs, { recursive: true });
fs.writeFileSync(tmpConfig, JSON.stringify({ settings: { mdRoot: tmpVault } }), 'utf-8');
process.env.LOG_DIR = tmpLogs;
process.env.INDEX_DIR = tmpLogs;
process.env.CONFIG_PATH = tmpConfig;
process.env.MD_ROOT = tmpVault;

const ROOT = path.join(__dirname, '..');
const K = require('../lib/kepan.js');
const UI = require('../kepan-sidebar.js');

const FM = '---\ntitle: "測試講記"\nsource: "《瑜伽師地論》卷一.《披尋記》Page5-Page9.1996/9/20.Tape1"\n---\n';   // 4 行

function doc(name, body) {
  return { name, text: FM + body };
}

describe('lib/kepan.js：中文數字與標題拆段', () => {
  test('cnNum 支援十、百與〇的寫法', () => {
    assert.equal(K.cnNum('一'), 1);
    assert.equal(K.cnNum('十'), 10);
    assert.equal(K.cnNum('十一'), 11);
    assert.equal(K.cnNum('二十三'), 23);
    assert.equal(K.cnNum('一〇三'), 103);
    assert.equal(K.cnNum('二百一十'), 210);
    assert.equal(K.cnNum('42'), 42);
  });

  test('一行多層的科判標題拆成多段，保留「分N科」', () => {
    const segs = K.parseHeadingSegments('## 甲一、本地分（分二科）  乙一、略辨地名（分二科）  丙一、徵');
    assert.deepEqual(segs.map(s => [s.ch, s.num, s.title, s.split]), [
      ['甲', 1, '本地分', 2], ['乙', 1, '略辨地名', 2], ['丙', 1, '徵', 0],
    ]);
  });

  test('缺頓號、句尾標點、「科）」後未空格都能拆', () => {
    assert.deepEqual(K.parseHeadingSegments('###### 卯二、現在相（分二科）　辰一標').map(s => s.ch + s.num + s.title), ['卯2現在相', '辰1標']);
    assert.deepEqual(K.parseHeadingSegments('### 未一、於誤殺（分二科）申一、標顛倒').map(s => s.ch + s.title), ['未於誤殺', '申標顛倒']);
    assert.equal(K.parseHeadingSegments('### 辛一、自性，')[0].title, '自性');
  });

  test('講解文字誤用標題格式、一般標題，都不是科判', () => {
    assert.deepEqual(K.parseHeadingSegments('##### 巳一、「標」。巳二、「所以者何」，是「徵」。'), []);
    assert.deepEqual(K.parseHeadingSegments('# 《瑜伽師地論》本地分（卷一．Tape 8）'), []);
    assert.deepEqual(K.parseHeadingSegments('一般段落 甲一、不是標題'), []);
  });

  test('「已」視為「巳」的誤植', () => {
    assert.equal(K.parseHeadingSegments('#### 已一、徵')[0].ch, '巳');
  });
});

describe('lib/kepan.js：建樹', () => {
  test('層級依字序判斷而非 # 數，跨卷重述同一科不重複建立', () => {
    const t = K.buildKepanTree([
      doc('T1', '## 甲一、本地分（分二科）  乙一、略辨地名\n\n內文\n\n###### 丙一、六個井號的科\n\n# 不是科判\n'),
      doc('T2', '## 乙一、略辨地名\n\n續講\n\n## 乙二、別廣地攝\n'),
    ], { title: '測試論' });
    const byLabel = Object.fromEntries(t.nodes.slice(1).map(n => [n.m + n.t, n]));
    assert.equal(t.nodes.length - 1, 4, '乙一在 T2 重述，不應多出一科');
    assert.equal(byLabel['丙一六個井號的科'].d, 2, '丙是第 3 層，與 ###### 無關');
    assert.equal(byLabel['丙一六個井號的科'].p, byLabel['乙一略辨地名'].id);
    assert.equal(byLabel['乙二別廣地攝'].p, byLabel['甲一本地分'].id);
    assert.deepEqual(t.files, ['T1', 'T2']);
    assert.equal(t.title, '測試論');
  });

  test('行號是原檔行號（含 frontmatter），heads 記每行最深的科', () => {
    const t = K.buildKepanTree([doc('T1', '## 甲一、本地分  乙一、略辨地名\n\n內文\n\n### 乙二、別廣地攝\n')]);
    const yi1 = t.nodes.find(n => n.m === '乙一');
    assert.equal(yi1.l, 5, 'frontmatter 4 行，標題在原檔第 5 行');
    assert.equal(yi1.f, 0);
    assert.deepEqual(t.heads[0], [[5, yi1.id], [9, t.nodes.find(n => n.m === '乙二').id]]);
  });

  test('「辰」同時是地支與千字文：依能否接續上一科決定層級', () => {
    const levels = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '天', '地', '玄', '黃', '宇', '宙', '洪', '荒', '日', '月', '盈', '昃'];
    const deep = levels.map(c => `${c}一、${c}科`).join('　');
    const t = K.buildKepanTree([doc('T1', `## ${deep}\n\n#### 辰一、千字文的辰\n\n#### 卯二、回到地支\n\n#### 辰一、地支的辰\n`)]);
    const chen = t.nodes.filter(n => n.m === '辰一');
    assert.equal(chen.find(n => n.t === '千字文的辰').d, 34, '昃（33）之下的辰是千字文第 35 層');
    assert.equal(chen.find(n => n.t === '地支的辰').d, 14, '卯二之下的辰是地支第 15 層');
    assert.equal(t.problems.filter(p => p.includes('層級字')).length, 0);
  });

  test('層級字誤植（巳寫成己）：依編號接續並記入 problems', () => {
    const t = K.buildKepanTree([doc('T1', [
      '## 甲一、甲（分二科）  乙一、乙  丙一、丙  丁一、丁  戊一、戊  己一、己  庚一、庚  辛一、辛  壬一、壬  癸一、癸  子一、子  丑一、丑  寅一、寅  卯一、卯  辰一、辰  巳一、一種',
      '### 巳二、二種',
      '### 己三、三種',
      '### 巳四、四種',
    ].join('\n\n'))]);
    const s3 = t.nodes.find(n => n.t === '三種');
    const s2 = t.nodes.find(n => n.t === '二種');
    assert.equal(s3.d, s2.d, '己三應與巳二同層');
    assert.equal(s3.p, s2.p);
    assert.equal(t.nodes.find(n => n.t === '四種').d, s2.d);
    assert.ok(t.problems.some(p => p.includes('己3') && p.includes('層級字')), t.problems.join('\n'));
  });

  test('「分N科」與實際子科數不符時記入 problems', () => {
    const t = K.buildKepanTree([doc('T1', '## 甲一、甲（分三科）  乙一、乙\n\n## 乙二、乙二\n')]);
    assert.ok(t.problems.some(p => p.includes('分3科') && p.includes('2 個子科')));
  });

  test('《披尋記》頁碼：卷首 source 的起始頁，之後以「《披尋記》N頁」更新', () => {
    const t = K.buildKepanTree([doc('T1', '## 甲一、甲  乙一、乙\n\n《披尋記》一〇三頁：\n\n> 引文\n\n## 乙二、乙二\n')]);
    assert.equal(t.nodes.find(n => n.m === '乙一').pg, 5);
    assert.equal(t.nodes.find(n => n.m === '乙二').pg, 103);
  });

  test('orderFiles：先依總目錄的連結順序，其餘自然排序', () => {
    assert.deepEqual(K.orderFiles(['T10', 'T2', 'T1', 'T74B', 'T74A'], null), ['T1', 'T2', 'T10', 'T74A', 'T74B']);
    assert.deepEqual(K.orderFiles(['T1', 'T2', 'T3'], '- [[T3|第三]]\n- [[T1]]\n- [[不存在]]'), ['T3', 'T1', 'T2']);
  });

  test('toClientPayload 精簡格式可由前端還原成同一棵樹', () => {
    const t = K.buildKepanTree([doc('T1', '## 甲一、甲  乙一、乙\n\n## 乙二、乙二  丙一、丙\n')], { title: '論' });
    const payload = K.toClientPayload(t, 'a/b');
    const N = UI.expandNodes(payload);
    assert.equal(N.length, t.nodes.length);
    t.nodes.forEach((n, i) => {
      assert.equal(N[i].d, n.d);
      assert.equal(N[i].p, n.p);
      assert.deepEqual(N[i].k, n.k);
      if (i) assert.equal(N[i].t, n.t);
    });
    assert.equal(payload.dir, 'a/b');
  });
});

/** 產生一個有 n 篇講記、每篇 m 個末端科的科判資料夾 */
function writeSeries(dir, n, m) {
  fs.mkdirSync(dir, { recursive: true });
  const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const toc = [];
  for (let i = 1; i <= n; i++) {
    const lines = [];
    if (i === 1) lines.push('## 甲一、總科（分' + CN[n] + '科）');
    lines.push(`## 乙${CN[i]}、第${i}篇（分${CN[m]}科）`);
    for (let j = 1; j <= m; j++) lines.push(`### 丙${CN[j]}、第${i}之${j}`, '', `第${i}篇第${j}科的講解。`, '');
    fs.writeFileSync(path.join(dir, `講記T${i}.md`), FM + lines.join('\n') + '\n');
    toc.push(`- [[講記T${i}]]`);
  }
  fs.writeFileSync(path.join(dir, '0總目錄.md'), toc.join('\n') + '\n');
  fs.mkdirSync(path.join(dir, '卷分QA'), { recursive: true });
  fs.writeFileSync(path.join(dir, '卷分QA', 'Q1.md'), '## 甲一、不應算進來\n');
}

describe('lib/kepan.js：資料夾判定與快取', () => {
  const dir = path.join(tmpRoot, 'cache-vault');
  before(() => {
    writeSeries(path.join(dir, '系列'), 5, 8);
    fs.mkdirSync(path.join(dir, '雜文'), { recursive: true });
    fs.writeFileSync(path.join(dir, '雜文', 'a.md'), '## 甲一、只有兩科\n## 甲二、不夠多\n');
    K.clearKepanCache();
  });

  test('科數夠多的資料夾才是科判系列；子資料夾與總目錄不算', async () => {
    const p = await K.getKepanForFile(dir, '系列/講記T2.md');
    assert.ok(p, '應判定為科判系列');
    assert.equal(p.nodes.length, 1 + 5 + 5 * 8);
    assert.deepEqual(p.files, ['講記T1', '講記T2', '講記T3', '講記T4', '講記T5']);
    assert.equal(p.dir, '系列');
    assert.equal(await K.getKepanForFile(dir, '雜文/a.md'), null);
    assert.equal(await K.getKepanForFile(dir, '不存在/x.md'), null);
  });

  test('同資料夾第二次讀取用快取；檔案修改後重建', async () => {
    const a = await K.getKepanForFile(dir, '系列/講記T1.md');
    const b = await K.getKepanForFile(dir, '系列/講記T5.md');
    assert.equal(a, b, '同一資料夾應回傳同一份快取');
    const f = path.join(dir, '系列', '講記T5.md');
    fs.appendFileSync(f, '### 丙九、新加的科\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const c = await K.getKepanForFile(dir, '系列/講記T5.md');
    assert.notEqual(c, a);
    assert.equal(c.nodes.length, a.nodes.length + 1);
  });
});

describe('/api/kepan 端對端', () => {
  let server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher;
  let baseUrl = '';
  function request(pathname, query, headers) {
    const url = new URL(pathname, baseUrl);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    return new Promise((resolve, reject) => {
      const req = http.request(url, { agent: false, headers: Object.assign({ Connection: 'close' }, headers) }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    writeSeries(path.join(tmpVault, '論', '講記'), 5, 8);
    fs.writeFileSync(path.join(tmpVault, 'plain.md'), '# 一般文件\n\n## 甲一、只有一科\n');
    ({ server, terminateWorkerPools, resetTreeWatcher, resetDictWatcher, resetConfigWatcher } = require('../server.js'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') await terminateWorkerPools();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('科判系列回傳精簡的樹，行號對得上 /api/render 的錨點', async () => {
    const r = await request('/api/kepan', { path: '論/講記/講記T3.md' });
    assert.equal(r.statusCode, 200);
    const { kepan } = JSON.parse(r.body);
    assert.equal(kepan.dir, '論/講記');
    assert.equal(kepan.files.length, 5);
    const [line, id] = kepan.heads[2][0];
    assert.equal(kepan.nodes[id - 1][1], '乙三');
    const html = (await request('/api/render', { path: '論/講記/講記T3.md' })).body;
    assert.ok(html.includes(`data-line="${line}"`) && html.indexOf(`data-line="${line}"`) < html.indexOf('第3篇'),
      `/api/render 應在第 ${line} 行的科判標題帶錨點`);
  });

  test('非科判資料夾回傳 { kepan: null }', async () => {
    const r = await request('/api/kepan', { path: 'plain.md' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), { kepan: null });
  });

  test('不存在、越界、非 Markdown 的路徑被拒', async () => {
    assert.equal((await request('/api/kepan', { path: '論/講記/沒有這篇.md' })).statusCode, 404);
    assert.equal((await request('/api/kepan', { path: '../../etc/passwd' })).statusCode, 404);
    assert.equal((await request('/api/kepan', { path: '論/講記/x.png' })).statusCode, 404);
    assert.equal((await request('/api/kepan', {})).statusCode, 404);
  });

  test('ETag：內容未變時回 304；支援 gzip', async () => {
    const r1 = await request('/api/kepan', { path: '論/講記/講記T1.md' }, { 'Accept-Encoding': 'gzip' });
    assert.equal(r1.headers['content-encoding'], 'gzip');
    assert.ok(r1.headers.etag);
    const r2 = await request('/api/kepan', { path: '論/講記/講記T1.md' }, { 'If-None-Match': r1.headers.etag });
    assert.equal(r2.statusCode, 304);
  });
});

describe('kepan-sidebar.js：側欄規則', () => {
  // 甲一 > 乙一 > 丙一（地）> 丁一 > 戊一 > … 一路深到第 20 層；另有 丙二
  const chain = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉'];
  const nodes = chain.map((c, i) => [i, c + '一', c + '科', 0, i < 10 ? 0 : 1, 10 + i]);
  nodes.push([2, '丙二', '第二地', 0, 1, 99]);
  const payload = { title: '論', files: ['T1', 'T2'], heads: { 0: [[10, 1], [12, 3], [19, 10]], 1: [[20, 11], [99, 21]] }, nodes };
  const N = UI.expandNodes(payload);

  test('expandNodes 依父科重建層級與子科', () => {
    assert.equal(N[20].d, 19);
    assert.deepEqual(N[2].k, [3, 21]);
    assert.equal(N[21].d, 2);
  });

  test('scopeOf：丙層以下屬於該「地」，淺於丙層屬於全論', () => {
    assert.equal(UI.scopeOf(N, 20), 3);
    assert.equal(UI.scopeOf(N, 3), 3);
    assert.equal(UI.scopeOf(N, 21), 21);
    assert.equal(UI.scopeOf(N, 2), 0);
  });

  test('縮排：前 5 層正常，之後每層只縮 3px；四十層仍在 300px 側欄內留得下字', () => {
    assert.equal(UI.indentFor(0), 0);
    assert.equal(UI.indentFor(5), 5 * UI.INDENT);
    assert.equal(UI.indentFor(6), 5 * UI.INDENT + UI.DEEP_INDENT);
    assert.ok(UI.indentFor(40) <= 300 - 120, `第 40 層縮排 ${UI.indentFor(40)}px，應留 120px（約 7 個字）以上給科名`);
  });

  test('只沿閱讀路徑展開；使用者手動收起的主幹科不自動打開', () => {
    const ex = UI.computeExpanded(N, new Set([21]), new Set(), 6);
    assert.deepEqual([...ex].sort((a, b) => a - b), [1, 2, 3, 4, 5, 21]);
    const closed = UI.computeExpanded(N, new Set(), new Set([4]), 6);
    assert.ok(!closed.has(4));
    assert.ok(closed.has(3));
  });

  test('visibleRows：範圍內依閱讀順序列出看得到的列', () => {
    const ex = UI.computeExpanded(N, new Set(), new Set(), 5);
    assert.deepEqual(UI.visibleRows(N, 3, ex), [3, 4, 5], '閱讀位置本身不自動展開');
    assert.deepEqual(UI.visibleRows(N, 0, new Set([1])), [1, 2]);
  });

  test('hereFromLine：取行號之前最後一個科判；卷首在第一個科判前時，仍屬上一卷最後的科', () => {
    assert.equal(UI.hereFromLine(payload, 0, 11), 1);
    assert.equal(UI.hereFromLine(payload, 0, 500), 10);
    assert.equal(UI.hereFromLine(payload, 1, 5), 10);
    assert.equal(UI.hereFromLine(payload, 1, 99), 21);
    assert.equal(UI.hereFromLine(payload, 0, 1), 1, '第一卷卷首沒有上一卷，取本卷第一科');
  });

  test('headingSegments 與 juanOf', () => {
    assert.deepEqual(UI.headingSegments('甲一、本地分（分二科）  乙一、略辨地名'), [
      { mark: '甲一', title: '本地分', split: '分二科' },
      { mark: '乙一', title: '略辨地名', split: '' },
    ]);
    assert.equal(UI.juanOf('《瑜伽師地論》本地分（卷九．Tape 92） — mdWebview'), '九');
    assert.equal(UI.juanOf('無卷數'), '');
  });
});

describe('kepan-sidebar.js：快速搜尋科名（v4.21.0）', () => {
  // 甲一 本地分 > 乙一 五識身相應地 > 丙一 五識身自性、丙二 意地 > 丁一 意地自性；乙二 意地 > 丙一 意自性
  const nodes = [
    [0, '甲一', '本地分', 0, 0, 1],
    [1, '乙一', '五識身相應地', 0, 0, 2],
    [2, '丙一', '五識身 自性', 0, 0, 3],
    [2, '丙二', '意地', 0, 0, 4],
    [4, '丁一', '意地自性', 0, 0, 5],
    [1, '乙二', '意地', 0, 1, 6],
    [6, '丙一', '意自性', 0, 1, 7],
  ];
  const N = UI.expandNodes({ title: '論', files: ['T1', 'T2'], heads: {}, nodes });

  test('normalizeQuery 去空白、全形空白與標點，英文轉小寫', () => {
    assert.equal(UI.normalizeQuery(' 五識身　自性、（分二科）'), '五識身自性分二科');
    assert.equal(UI.normalizeQuery('Tape 92'), 'tape92');
  });

  test('找科名：依閱讀順序；空白不影響比對', () => {
    assert.deepEqual(UI.searchNodes(N, '自性').ids, [3, 5, 7]);
    assert.deepEqual(UI.searchNodes(N, '五識身自性').ids, [3], '原文「五識身 自性」中間有空白也找得到');
  });

  test('多個關鍵字須全部符合，可混用科判字與科名', () => {
    assert.deepEqual(UI.searchNodes(N, '意地 自性').ids, [5]);
    assert.deepEqual(UI.searchNodes(N, '丙一 意').ids, [7]);
  });

  test('輸入科判字：該字號的科排最前', () => {
    assert.deepEqual(UI.searchNodes(N, '丙一').ids, [3, 7]);
    assert.deepEqual(UI.searchNodes(N, '丙二').ids, [4]);
  });

  test('目前範圍（地）的結果排前面，並回報數量', () => {
    const r = UI.searchNodes(N, '自性', { rootId: 4 });
    assert.equal(UI.scopeOf(N, 5), 4);
    assert.deepEqual(r.ids, [5, 3, 7]);
    assert.equal(r.inScope, 1);
    assert.equal(r.total, 3);
  });

  test('空字串不回傳結果；limit 限制列出數量但 total 仍是全部', () => {
    assert.deepEqual(UI.searchNodes(N, '  ').ids, []);
    const r = UI.searchNodes(N, '地', { limit: 2 });
    assert.equal(r.ids.length, 2);
    assert.equal(r.total, 5);
  });

  test('hay 快取：同一份陣列重複搜尋，結果一致', () => {
    const hay = [];
    assert.deepEqual(UI.searchNodes(N, '意', { hay }).ids, UI.searchNodes(N, '意').ids);
    assert.equal(hay.length, N.length);
    assert.deepEqual(UI.searchNodes(N, '意', { hay }).ids, [4, 5, 6, 7]);
  });
});

describe('接線（靜態檢查）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('index.html：科判分頁預設隱藏、面板與閱讀框元件齊全、腳本在 app.js 之前載入', () => {
    assert.match(html, /<button class="sidebar-tab" data-tab="kepan"[^>]*hidden>/);
    for (const id of ['panelKepan', 'kepanScope', 'kepanTree', 'kepanSpacer', 'kepanToast', 'kepanBar', 'kepanLandmark', 'kepanPath', 'kepanNav', 'kepanPrev', 'kepanNext']) {
      assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
    }
    // 快速搜尋：在下拉選單下方，結果清單在樹之前
    const scope = html.indexOf('id="kepanScope"'), search = html.indexOf('id="kepanSearch"');
    assert.ok(search > scope && search < html.indexOf('id="kepanTree"'), '搜尋框應在下拉選單下方、樹之上');
    assert.match(html, /<input type="search" id="kepanSearch"[^>]*role="combobox"[^>]*aria-controls="kepanResults"/);
    assert.match(html, /id="kepanSearch" class="sidebar-filter-input"/, '沿用側欄篩選框樣式（手機 16px 防縮放）');
    assert.match(html, /<div class="kepan-results" id="kepanResults" role="listbox"[^>]*hidden>/);
    const k = html.indexOf(`kepan-sidebar.js?v=${pkg.version}`);
    assert.ok(k > 0, 'kepan-sidebar.js 應帶目前版本號');
    assert.ok(k < html.indexOf('app.js?v='), 'kepan-sidebar.js 應在 app.js 之前');
  });

  test('app.js：渲染後通知科判側欄、回首頁時關閉，並提供開檔函式', () => {
    assert.ok(app.includes('window.MdwKepan.onDocumentRendered(state.currentFile)'));
    assert.ok(app.includes('window.MdwKepan.onDocumentClosed()'));
    assert.ok(app.includes('window.mdwOpenFile = (filePath, line) => openFile(filePath, line)'));
  });

  test('快速搜尋鍵盤操作：輸入法選字中不搜尋不跳轉；Enter 前往、Esc 清除、↑↓ 選擇', () => {
    const js = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
    assert.ok(js.includes("addEventListener('compositionstart'"));
    assert.ok(js.includes("addEventListener('compositionend'"));
    assert.match(js, /if \(e\.isComposing \|\| S\.composing \|\| e\.keyCode === 229\) return;/);
    for (const k of ["'Enter'", "'Escape'", "'ArrowDown'", "'ArrowUp'"]) assert.ok(js.includes(`e.key === ${k}`), `缺少 ${k}`);
    assert.ok(js.includes('chooseHit(S.found[Math.max(0, S.active)])'), 'Enter 預設前往第一筆');
  });

  test('離線與 Docker 映像都帶上 kepan-sidebar.js 與 lib/kepan.js', () => {
    assert.ok(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').includes("'/kepan-sidebar.js'"));
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(docker, /^COPY .*\bkepan-sidebar\.js\b/m);
    assert.match(docker, /^COPY lib\/ \.\/lib\//m);
  });
});
