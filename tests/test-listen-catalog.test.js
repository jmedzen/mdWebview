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

describe('經文起訖：略過他人寫的序與經後附錄（autoBounds）', () => {
  /** 仿大正藏心經：CBETA 檔頭、兩篇序（含作者行「…撰」）、經名＋譯者、經文、經名、品目清單。 */
  function heart() {
    return ['//【經文資訊】大正藏第 8 冊 No. 251 般若波羅蜜多心經', '', 'No. 251 [Nos. 250, 252-255, 257]',
      '大明太祖高皇帝御製般若心經序', '', '二儀久判，萬物備周，子民者君君，育民者法其法也。',
      '', '般若波羅蜜多心經序', '', '唐釋慧忠撰', '', '夫法性無邊，豈藉心之所度；真如非相，詎假言之所詮。',
      '', '般若波羅蜜多心經', '', '唐三藏法師玄奘譯', '', '觀自在菩薩行深般若波羅蜜多時，照見五蘊皆空，度一切苦厄。',
      '', '「揭帝　揭帝　般羅揭帝　般羅僧揭帝　菩提　僧莎訶」', '', '般若波羅蜜多心經',
      '', '大明太祖高皇帝御製序', '般若波羅蜜多心經序', ''].join('\n');
  }
  const item = (extra) => Object.assign({ id: 'h', name: '心經', path: 'x.md', split: 'auto', range: null, parts: [] }, extra || {});
  const lineOf = (text, s) => text.split('\n').indexOf(s) + 1;

  test('從「經名＋譯者」讀起，讀到最後一個經名行為止；後台看得到略過了什麼', () => {
    const t = heart(); const e = entryOf(t, 'x.md');
    const r = resolveItem(item(), e);
    assert.equal(r.line, lineOf(t, '般若波羅蜜多心經'));
    assert.equal(r.endLine, lineOf(t, '大明太祖高皇帝御製序'));
    assert.equal(r.skipped.head.line, lineOf(t, '大明太祖高皇帝御製般若心經序'));
    assert.equal(r.skipped.head.endLine, r.line);
    assert.ok(r.skipped.head.chars > 30);
    assert.equal(r.skipped.tail.text, '大明太祖高皇帝御製序');
  });

  test('trim:false 整個檔案都讀（舊行為）', () => {
    const e = entryOf(heart(), 'x.md');
    const r = resolveItem(item({ trim: false }), e);
    assert.equal(r.endLine, 0);
    assert.equal(r.skipped.head, null);
    assert.ok(r.chars > resolveItem(item(), e).chars);
  });

  test('沒有序的經（經名＋譯者就在開頭）範圍不變、不報略過', () => {
    const t = ['No. 366', '佛說阿彌陀經', '', '姚秦龜茲三藏鳩摩羅什譯', '', '如是我聞：一時，佛在舍衛國。', '', '佛說阿彌陀經', ''].join('\n');
    const r = resolveItem(item(), entryOf(t, 'x.md'));
    assert.equal(r.line, 2); assert.equal(r.endLine, 0);
    assert.equal(r.skipped.head, null); assert.equal(r.skipped.tail, null);
  });

  test('經末卷名行（「維摩詰經卷下」）之後的品目清單不讀；經名帶夾注也認得', () => {
    const t = ['維摩詰所說經(一名不可思議解脫上卷)', '', '姚秦三藏鳩摩羅什譯', '', '## 佛國品第一', '', '如是我聞：一時，佛在毘耶離菴羅樹園。',
      '', '## 維摩詰經卷下', '', '1 佛國品', '2 方便品', ''].join('\n');
    const r = resolveItem(item(), entryOf(t, 'x.md'));
    assert.equal(r.line, 1);
    assert.equal(r.endLine, lineOf(t, '1 佛國品'));
  });

  test('沒有譯者行就不動起點；序作者行「…撰」「…述」不算譯者行', () => {
    const t = ['某某序', '', '唐終南山釋道宣述', '', '序文，說明來歷。', '', '經文第一段，如是我聞。', ''].join('\n');
    const r = resolveItem(item(), entryOf(t, 'x.md'));
    assert.equal(r.line, 1); assert.equal(r.skipped.head, null);
  });

  test('節錄指定了終點就不套用；只指定起點時仍截掉經後附錄', () => {
    const t = heart(); const e = entryOf(t, 'x.md');
    const from = { head: '般若波羅蜜多心經', line: lineOf(t, '般若波羅蜜多心經') };
    const a = resolveItem(item({ range: { from, to: null } }), e);
    assert.equal(a.line, from.line); // 起點照節錄
    assert.equal(a.endLine, lineOf(t, '大明太祖高皇帝御製序'));
    const b = resolveItem(item({ range: { from, to: { head: '大明太祖高皇帝御製序', line: 99 } } }), e);
    assert.equal(b.line, from.line); assert.equal(b.endLine, lineOf(t, '大明太祖高皇帝御製序'));
    assert.equal(b.skipped.tail, null);
  });

  test('經文中間插入的序（法華經普門品前的御製序）到下一個品題之前不讀：區間、字數、預先生成都扣掉', () => {
    const t = ['妙法蓮華經', '', '姚秦三藏法師鳩摩羅什譯', '', '## 妙音菩薩品第二十四', '', '爾時釋迦牟尼佛放大人相肉髻光明。',
      '', '御製觀世音普門品經序', '', '觀世音菩薩，以爍迦羅心應變無窮，為諸佛之所稱讚。', '', '永樂九年五月初一日',
      '', '隋北天竺沙門闍那崛多譯重頌', '', '## 觀世音菩薩普門品第二十五', '', '爾時無盡意菩薩即從座起。', ''].join('\n');
    const e = entryOf(t, 'x.md');
    const r = resolveItem(item(), e);
    const a = lineOf(t, '御製觀世音普門品經序'); const b = lineOf(t, '## 觀世音菩薩普門品第二十五');
    assert.deepEqual(r.skip, [[a, b]]);
    assert.equal(r.skipped.mid[0].text, '御製觀世音普門品經序');
    const off = resolveItem(item({ trim: false }), e);
    assert.equal(r.chars, off.chars - r.skipped.mid[0].chars);
    assert.equal(r.parts[0].chars + r.parts[1].chars, r.chars);
    assert.deepEqual(lc._internals.readSegments(r), [[r.line, a], [b, 0]]);
  });

  test('經名夾注裡有逗號也認得；譯者行之前已是經文（品題、如是我聞）就不動起點', () => {
    const t1 = ['賢劫經卷第一(亦名颰陀劫三昧，晉曰賢劫定意經)', '', '西晉月氏三藏竺法護譯', '', '聞如是：一時佛遊王舍城。', ''].join('\n');
    const r1 = resolveItem(item(), entryOf(t1, 'x.md'));
    assert.equal(r1.line, 1); assert.equal(r1.skipped.head, null);
    const t2 = ['## 中阿含經卷第一', '', '東晉孝武及安帝世隆安元年十一月至二年六月了於東亭寺罽賓三藏瞿曇僧伽提婆譯道祖筆受', '',
      '## 中阿含七法品第一', '', '我聞如是：一時，佛遊舍衛國。', '', '## 中阿含經卷第二', '', '東晉罽賓三藏瞿曇僧伽提婆譯', '', '我聞如是：一時，佛遊拘樓瘦。', ''].join('\n');
    const r2 = resolveItem(item(), entryOf(t2, 'x.md'));
    assert.equal(r2.line, 1); assert.equal(r2.skipped.head, null);
  });

  test('讀者端照 skip 跳過：ttsPlayable 排除略過的行，聽經播放把 item.skip 傳給朗讀', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.match(app, /function ttsPlayable\(it\) \{ return !!it && it\.kind !== 'skip' && !ttsInSkip\(it\); \}/);
    assert.match(app, /ttsRt\.skipLines = null;/);
    assert.match(app, /if \(item\.skip && item\.skip\.length\) ro\.skip = item\.skip;/);
  });

  test('存檔保留 trim；預設經目都是 trim:true；後台有開關與說明', () => {
    const c = lc.sanitizeCatalog({ categories: [{ id: 'a', name: 'A' }], items: [{ name: 'x', path: 'a.md', cat: 'a', trim: false }, { name: 'y', path: 'b.md', cat: 'a' }] });
    assert.equal(c.items[0].trim, false); assert.equal(c.items[1].trim, true);
    assert.ok(defaultCatalog().items.every(i => i.trim === true));
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.match(app, /data-lc-f="trim"/);
    assert.match(app, /function lcSkippedHint\(it, d\)/);
  });
});

describe('後台：直接編輯群組與經目（validateCatalog、app.js §21.9 lcValidate）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 前端的 lcValidate 抽出來在 vm 裡跑，和伺服器用同一批案例比對
  const src = app.slice(app.indexOf('  function lcValidate(c) {'), app.indexOf('  function renderLcIssues() {'));
  const lcValidate = vm.runInNewContext(`(${src.trim()})`);
  const good = () => ({
    categories: [{ id: 'a', name: '淨土', note: '' }, { id: 'b', name: '般若', note: '' }],
    items: [
      { id: 'i1', name: '阿彌陀經', cat: 'a', path: 'x/T0366.md', enabled: true, range: null },
      { id: 'i2', name: '心經', cat: 'b', path: 'x/T0251.md', enabled: true, range: null }
    ]
  });
  const both = (c) => { const s = lc.validateCatalog(c); const f = JSON.parse(JSON.stringify(lcValidate(c))); return { s, f }; };
  const codes = (v) => JSON.parse(JSON.stringify(v.errors.map(e => e.msg).sort()));

  test('正常的目錄沒有錯誤也沒有提醒', () => {
    const { s, f } = both(good());
    assert.deepEqual(s, { errors: [], warnings: [] });
    assert.deepEqual(f, { errors: [], warnings: [] });
  });

  test('群組名稱空白或重複是錯誤（前後端訊息一致）', () => {
    const c = good(); c.categories[1].name = '  ';
    let { s, f } = both(c);
    assert.deepEqual(s.errors.map(e => e.msg), ['有群組沒有名稱']);
    assert.deepEqual(codes(f), codes(s));
    const d = good(); d.categories[1].name = '淨土';
    ({ s, f } = both(d));
    assert.equal(s.errors[0].code, 'group-dup');
    assert.equal(s.errors[0].cat, 'b');
    assert.deepEqual(codes(f), codes(s));
  });

  test('經沒有名稱、檔案不是 .md、群組不存在都是錯誤', () => {
    const c = good();
    c.items[0].name = ''; c.items[1].path = 'x/T0251.txt'; c.items.push({ id: 'i3', name: '孤兒', cat: 'zz', path: 'x/a.md' });
    const { s, f } = both(c);
    assert.deepEqual(s.errors.map(e => e.code).sort(), ['item-group', 'item-name', 'item-path']);
    assert.deepEqual(codes(f), codes(s));
  });

  test('同一檔案同一段重複、群組沒有顯示中的經只是提醒', () => {
    const c = good();
    c.items.push({ id: 'i4', name: '阿彌陀經（重複）', cat: 'a', path: 'x/T0366.md', enabled: true, range: null });
    c.items[1].enabled = false; // 般若群組只剩不顯示的經
    const { s, f } = both(c);
    assert.equal(s.errors.length, 0);
    assert.deepEqual(s.warnings.map(w => w.code).sort(), ['group-empty', 'item-dup']);
    assert.deepEqual(f.warnings.map(w => w.msg).sort(), s.warnings.map(w => w.msg).sort());
    // 不同段（節錄）不算重複
    c.items[2].range = { from: { head: '普門品', line: 10 }, to: null };
    assert.equal(lc.validateCatalog(c).warnings.filter(w => w.code === 'item-dup').length, 0);
  });

  test('存檔 API：有錯誤時回 400 不存，沒錯誤才寫入設定', () => {
    const route = lc.handle.toString();
    assert.match(route, /const v = validateCatalog\(body\.catalog\);\s*if \(v\.errors\.length\) \{ sendJSON\(res, 400, \{ error: v\.errors\[0\]\.msg, code: 'INVALID_CATALOG'/);
  });

  test('畫面：群組在經目清單上直接改名、排序、刪除、加經；不再藏在「分類…」裡', () => {
    assert.match(html, /id="lcAddCatBtn"[^>]*>＋ 新增群組</);
    assert.doesNotMatch(html, /id="lcCatsBtn"/);
    assert.match(html, /id="lcIssues" role="status" aria-live="polite" hidden/);
    assert.match(html, /id="lcTotals"/);
    for (const a of ['edit', 'done', 'up', 'down', 'del', 'additem']) assert.match(app, new RegExp(`data-lc-cact="${a}"`));
    assert.match(app, /<label for="lcCat">群組<\/label>/);
  });

  test('經排到群組頭尾再按一次就移到相鄰群組；刪除群組時裡面的經移到相鄰群組', () => {
    assert.match(app, /跨群組：移到上一個群組的最後，或下一個群組的最前/);
    assert.match(app, /const to = c\.categories\[k - 1\] \|\| c\.categories\[k \+ 1\];/);
    assert.match(app, /disabled' : ''}>↑<\/button>/);
  });

  test('儲存前跑 lcValidate，有錯誤不送出；存好後收起朗讀頁的舊估算', () => {
    const at = app.indexOf("$('lcSaveBtn').addEventListener"); const save = app.slice(at, at + 2000);
    assert.match(save, /const v = lcValidate\(c\);\s*if \(v\.errors\.length\) \{/);
    assert.match(save, /renderTtsLcEstimate\(null\);/);
  });
});
