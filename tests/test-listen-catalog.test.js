/**
 * 聽經目錄（lib/listen-catalog.js、app.js §17d／§21.9）：
 *   1. 品卷偵測：品優先於卷、卷尾重複的卷標題略過、名稱去掉經名前綴
 *   2. 錨點：檔案前面多了幾行時仍找得到同一品；對不到時回報問題而不是讀錯地方
 *   3. 節錄（普門品）、手動分段（壇經）、不收錄與改名的覆寫
 *   4. 存檔的驗證、讀者端只列出顯示中且檔案存在的經
 *   5. 前端契約：/?listen 路由、揭露按鈕、停止行
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Seg = require('../tts-segment.js');
const { config } = require('../lib/config.js');
const lc = require('../lib/listen-catalog.js');
const { scanHeadings, autoParts, resolveItem, findAnchor, partLabel, defaultCatalog, resolvedCache } = lc._internals;

const ROOT = path.resolve(__dirname, '..');

/** 仿大正藏法華經：卷標題、品標題、卷尾重複的卷標題。 */
function lotus(prefixLines) {
  const L = [];
  for (let i = 0; i < (prefixLines || 0); i++) L.push('', `前言第 ${i + 1} 段，說明本經的來歷。`);
  L.push('', '妙法蓮華經', '', '姚秦三藏法師鳩摩羅什譯');
  const juan = ['一', '二'];
  const pins = [['序品第一', '方便品第二'], ['譬喻品第三', '信解品第四']];
  juan.forEach((j, x) => {
    L.push('', `## 妙法蓮華經卷第${j}`);
    pins[x].forEach((p, y) => {
      L.push('', `## ${x + y === 0 ? '' : '妙法蓮華經'}${p}`);
      for (let k = 0; k < 3; k++) L.push('', `如是我聞，一時佛住王舍城，${p}第${k + 1}段經文。`);
    });
    L.push('', `## 妙法蓮華經卷第${j}`); // 卷尾
  });
  return L.join('\n') + '\n';
}

function entryOf(text, rel) {
  const d = Seg.segmentDoc(text, {});
  return { relPath: rel || '01-大正藏/04法華部類/T0262《妙法蓮華經》.md', sig: String(text.length), units: d.units, title: 'x' };
}

describe('品卷偵測', () => {
  test('有品就依品分段，卷成為分組；卷尾重複的卷標題略過', () => {
    const e = entryOf(lotus());
    const hs = scanHeadings(e.units);
    assert.deepEqual(hs.filter(h => h.type === '卷').map(h => h.head), ['妙法蓮華經卷第一', '妙法蓮華經卷第二']);
    const r = autoParts(e.units, 'auto', 0, e.units.length);
    assert.equal(r.unit, '品');
    assert.deepEqual(r.parts.map(p => p.title), ['序品第一', '方便品第二', '譬喻品第三', '信解品第四']);
    assert.deepEqual(r.parts.map(p => p.juan), ['卷第一', '卷第一', '卷第二', '卷第二']);
  });

  test('「依卷」只用卷標題', () => {
    const e = entryOf(lotus());
    const r = autoParts(e.units, 'juan', 0, e.units.length);
    assert.equal(r.unit, '卷');
    assert.deepEqual(r.parts.map(p => p.title), ['卷第一', '卷第二']);
  });

  test('名稱：去掉經名前綴，但不吃掉品名裡的「經」字', () => {
    assert.equal(partLabel('妙法蓮華經觀世音菩薩普門品第二十五', '品'), '觀世音菩薩普門品第二十五');
    assert.equal(partLabel('持經品第十', '品'), '持經品第十');
    assert.equal(partLabel('地藏菩薩本願經卷上', '卷'), '卷上');
    assert.equal(partLabel('大方廣佛華嚴經卷第八十', '卷'), '卷第八十');
  });

  test('沒有品卷標題的短經不分段', () => {
    const e = entryOf('般若波羅蜜多心經\n\n觀自在菩薩，行深般若波羅蜜多時，照見五蘊皆空，度一切苦厄。\n');
    const r = resolveItem({ split: 'auto', range: null, parts: [] }, e);
    assert.equal(r.unit, '');
    assert.deepEqual(r.parts, []);
    assert.ok(r.chars > 20);
  });

  test('每品的長度加起來等於全經（經名、譯者算在第一品）', () => {
    const e = entryOf(lotus());
    const r = resolveItem({ split: 'auto', range: null, parts: [] }, e);
    assert.equal(r.parts.reduce((n, p) => n + p.chars, 0), r.chars);
    assert.equal(r.parts[0].endLine, r.parts[1].line);
  });
});

describe('錨點與覆寫', () => {
  test('檔案前面多了幾段，覆寫仍對應到同一品', () => {
    const before = entryOf(lotus(0));
    const p2 = resolveItem({ split: 'auto', range: null, parts: [] }, before).parts[1];
    const item = { split: 'auto', range: null, parts: [{ head: p2.head, line: p2.line, title: '方便品（第二）', on: true }] };
    const after = entryOf(lotus(6));
    const r = resolveItem(item, after);
    assert.equal(r.parts[1].t, '方便品（第二）');
    assert.ok(r.parts[1].line > p2.line);
  });

  test('不收錄的品不列出，但仍是上一品的終點；後台模式會列出並標 off', () => {
    const e = entryOf(lotus());
    const all = resolveItem({ split: 'auto', range: null, parts: [] }, e).parts;
    const item = { split: 'auto', range: null, parts: [{ head: all[2].head, line: all[2].line, title: '', on: false }] };
    const r = resolveItem(item, e);
    assert.deepEqual(r.parts.map(p => p.t), ['序品第一', '方便品第二', '信解品第四']);
    assert.equal(r.parts[1].endLine, all[2].line);
    const adm = resolveItem(item, e, { all: true });
    assert.equal(adm.parts.length, 4);
    assert.equal(adm.parts[2].off, true);
  });

  test('節錄：只取一品，終點是下一品', () => {
    const e = entryOf(lotus());
    const all = resolveItem({ split: 'auto', range: null, parts: [] }, e).parts;
    const r = resolveItem({ split: 'none', parts: [], range: { from: { head: all[2].head, line: all[2].line }, to: { head: all[3].head, line: all[3].line } } }, e);
    assert.equal(r.line, all[2].line);
    assert.equal(r.endLine, all[3].line);
    assert.equal(r.chars, all[2].chars);
    assert.deepEqual(r.issues, []);
  });

  test('節錄起點對不到時回報問題，不默默改讀全經以外的地方', () => {
    const e = entryOf(lotus());
    const r = resolveItem({ split: 'none', parts: [], range: { from: { head: '不存在的品第九十', line: 5 }, to: null } }, e);
    assert.deepEqual(r.issues, ['range-start']);
  });

  test('手動分段：用獨立成行的段首（壇經「行由第一」）', () => {
    const text = '六祖大師法寶壇經\n\n行由第一\n\n時，大師至寶林。\n\n般若第二\n\n次日，韋使君請益。\n\n疑問第三\n\n一日，韋刺史為師設大會齋。\n';
    const e = entryOf(text, '01-大正藏/17禪宗部類/T2008.md');
    const parts = ['行由第一', '般若第二', '疑問第三', '不存在第九'].map((h, i) => ({ head: h, line: 3 + i * 4, title: h, on: true }));
    const r = resolveItem({ split: 'manual', range: null, parts }, e);
    assert.deepEqual(r.parts.map(p => p.t), ['行由第一', '般若第二', '疑問第三']);
    assert.deepEqual(r.issues, ['part:不存在第九']);
    assert.equal(findAnchor(e.units, { head: '般若第二', line: 1 }), r.parts[1] && e.units.findIndex(u => u.line === r.parts[1].line));
  });
});

describe('存檔與讀者端目錄', () => {
  beforeEach(() => { delete config.settings.listenCatalog; resolvedCache.clear(); });

  test('驗證：沒有名稱或不是 .md 的經丟掉；未知分類歸到第一類；id 重複會換掉', () => {
    const c = lc.sanitizeCatalog({
      categories: [{ id: 'a', name: '淨土' }, { id: 'a', name: '重複' }, { name: '' }],
      items: [
        { id: 'x', name: '阿彌陀經', path: 'a/b.md', cat: 'zzz', split: 'weird' },
        { id: 'x', name: '心經', path: 'a/c.md', cat: 'a', parts: [{ head: '', line: 3 }, { head: '序品第一', line: 9, on: false }] },
        { name: '', path: 'a/d.md' },
        { name: '壞路徑', path: 'a/e.txt' }
      ]
    });
    assert.equal(c.categories.length, 2);
    assert.notEqual(c.categories[0].id, c.categories[1].id);
    assert.equal(c.items.length, 2);
    assert.equal(c.items[0].cat, 'a');
    assert.equal(c.items[0].split, 'auto');
    assert.notEqual(c.items[0].id, c.items[1].id);
    assert.deepEqual(c.items[1].parts, [{ head: '序品第一', line: 9, title: '', on: false }]);
  });

  test('預設經目：15 部，普門品是節錄；收大品般若（T0223），不收楞嚴、壇經', () => {
    const d = defaultCatalog();
    assert.equal(d.items.length, 15);
    const pm = d.items.find(i => i.name === '觀世音菩薩普門品');
    assert.ok(pm.range && pm.range.from.head.endsWith('普門品第二十五'));
    const dp = d.items.find(i => i.path.includes('T0223'));
    assert.equal(dp.name, '摩訶般若波羅蜜經');
    assert.equal(dp.cat, 'bore');
    assert.equal(dp.split, 'auto');
    assert.equal(dp.path, '01-大正藏/03般若部類/T0223《摩訶般若波羅蜜經》.md');
    assert.ok(!d.items.some(i => /T0945|T2008/.test(i.path)));
    assert.ok(!d.items.some(i => /楞嚴|壇經/.test(i.name)));
    assert.equal(new Set(d.items.map(i => i.id)).size, d.items.length);
  });

  test('品名尾端的校勘夾注（大品般若「習應品第三(丹本名為習相應品)」）不影響偵測，顯示名稱去掉夾注', () => {
    const text = ['', '## 摩訶般若波羅蜜經卷第一', '', '後秦龜茲國三藏鳩摩羅什譯', '', '## 序品第一', '', '如是我聞。',
      '', '## 摩訶般若波羅蜜經奉鉢品第二', '', '爾時世尊。', '', '## 摩訶般若波羅蜜經習應品第三(丹本名為習相應品)', '', '舍利弗。',
      '', '## 摩訶般若經卷第一', '', '## 摩訶般若波羅蜜經卷第二', '', '## 往生品第四', '', '佛告舍利弗。',
      '', '## 幻學品第十一（丹本云幻人品）', '', '須菩提白佛言。', ''].join('\n');
    const e = entryOf(text, '01-大正藏/03般若部類/T0223.md');
    const r = autoParts(e.units, 'auto', 0, e.units.length);
    assert.equal(r.unit, '品');
    assert.deepEqual(r.parts.map(p => p.title), ['序品第一', '奉鉢品第二', '習應品第三', '往生品第四', '幻學品第十一']);
    assert.deepEqual(r.parts.map(p => p.juan), ['卷第一', '卷第一', '卷第一', '卷第二', '卷第二']);
    // 錨點仍是原文（含夾注），存檔的覆寫對得回去
    assert.equal(r.parts[2].head, '摩訶般若波羅蜜經習應品第三(丹本名為習相應品)');
    const item = { split: 'auto', range: null, parts: [{ head: r.parts[2].head, line: r.parts[2].line, title: '習相應品第三', on: true }] };
    assert.equal(resolveItem(item, e).parts[2].t, '習相應品第三');
  });

  test('讀者端只列出顯示中、檔案存在的經；空的分類不列', async () => {
    const docs = { 'k/lotus.md': entryOf(lotus(), 'k/lotus.md') };
    lc.init({ loadDoc: async (p) => docs[p] || null });
    config.settings.listenCatalog = lc.sanitizeCatalog({
      categories: [{ id: 'f', name: '法華' }, { id: 'e', name: '空的' }],
      items: [
        { id: 'a', name: '妙法蓮華經', path: 'k/lotus.md', cat: 'f' },
        { id: 'b', name: '隱藏', path: 'k/lotus.md', cat: 'f', enabled: false },
        { id: 'c', name: '不存在', path: 'k/none.md', cat: 'f' }
      ]
    });
    const d = await lc.publicCatalog();
    assert.deepEqual(d.items.map(i => i.id), ['a']);
    assert.deepEqual(d.categories.map(c => c.id), ['f']);
    assert.equal(d.items[0].unit, '品');
    assert.equal(d.items[0].parts.length, 4);
    assert.ok(!('head' in d.items[0].parts[0]), '讀者端不需要錨點文字');
    // 訪客用：每部經已生成幾成（依音色快取）
    lc.init({ coverage: async (p, voice) => (voice === 'v1' ? { voiced: 8, cached: 8 } : { voiced: 8, cached: 2 }) });
    const res = { headers: {}, setHeader() {}, writeHead(c, h) { this.code = c; }, end(b) { this.body = b; } };
    assert.equal(await lc.handle({ method: 'GET' }, res, '/api/listen/ready', { voice: 'v1' }), true);
    assert.deepEqual(JSON.parse(res.body).items, { a: 100 });
    await lc.handle({ method: 'GET' }, res, '/api/listen/ready', { voice: 'v2' });
    assert.deepEqual(JSON.parse(res.body).items, { a: 25 });
    assert.ok(lc.isListenRoute('/api/listen/ready'));
    const adm = await lc.adminCatalog();
    assert.equal(adm.status.c.ok, false);
    assert.deepEqual(lc.catalogFiles(), ['k/lotus.md', 'k/none.md']);
  });
});

describe('前端契約', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const listen = app.slice(app.indexOf('§17d LISTEN CATALOG'), app.indexOf('§18 READ PROGRESS'));

  test('/?listen 解析成聽經頁；有 file 時仍是開經文', () => {
    const src = app.slice(app.indexOf('function parseUrlParams(search, hash)'));
    const body = src.slice(0, src.indexOf('\n  }\n') + 4);
    const dec = app.slice(app.indexOf('function safeDecodeURIComponent(str)'));
    const decBody = dec.slice(0, dec.indexOf('\n  }\n') + 4);
    const sb = { URLSearchParams, console };
    vm.createContext(sb);
    vm.runInContext(`${decBody}\n${body}\nglobalThis.p = parseUrlParams;`, sb);
    assert.deepEqual({ ...sb.p('?listen', '') }, { isListen: true });
    assert.notEqual(sb.p('?listen&file=a.md', '').isListen, true);
  });

  test('品卷用揭露按鈕（aria-expanded／aria-controls），不用樹狀角色', () => {
    assert.match(listen, /aria-expanded="\$\{open\}" aria-controls="\$\{pid\}"/);
    assert.doesNotMatch(listen, /role="tree/);
    assert.match(listen, /<h1 id="listenTitle" tabindex="-1">聽經<\/h1>/);
    assert.match(listen, /aria-pressed=/);
    assert.match(listen, /aria-label="從\$\{escHtml\(pt\.t\)\}開始讀誦/);
  });

  test('只讀這一品用 stopLine 停下，聽經的經讀完不接同資料夾的下一篇', () => {
    assert.match(app, /if \(ttsRt\.stopLine && nx\.line >= ttsRt\.stopLine\) return ttsFinish\(\);/);
    assert.match(app, /ttsRt\.stopLine \|\| ttsRt\.listen\) return false;/);
  });

  test('入口：首頁按鈕、朗讀選單、聽經頁容器都在', () => {
    assert.match(html, /id="homeListen" hidden/);
    assert.match(html, /data-tts-act="listen" hidden/);
    assert.match(html, /<div class="listen-view" id="listenView" hidden><\/div>/);
    assert.match(html, /data-page="listen" data-pane="listen"/);
  });
});

describe('後台：聽經目錄一次預先生成（app.js §21.8）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  test('預先生成卡片裡有聽經目錄區：音色勾選、釘選、先估算再開始', () => {
    const card = html.slice(html.indexOf('id="adminTtsJobsCard"'), html.indexOf('id="adminTtsJobs"'));
    assert.match(card, /id="adminTtsLcVoices"/);
    assert.match(card, /id="adminTtsLcPin" checked/);
    assert.match(card, /id="adminTtsLcEstimateBtn"[^>]*>預先生成聽經目錄…</);
    assert.match(card, /id="adminTtsLcEstimate"[^>]*aria-live="polite"/);
  });
  test('估算與開始都用 listen:catalog，多音色以 voices 送出；完成報告列出失敗並可重試', () => {
    assert.match(app, /'\/api\/admin\/tts\/jobs\/estimate', \{ method: 'POST', body: \{ scope: 'listen:catalog', voices \}/);
    assert.match(app, /body: \{ scope: 'listen:catalog', voices: ttsAdmin\.lcVoices/);
    assert.match(app, /acts\.push\(\['retry', '重試失敗的句子'\]\)/);
    assert.match(app, /聲音被截斷/);
  });
});
