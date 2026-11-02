/**
 * 每日經文兩個來源（後台文字框 + sutra-quote/ 資料夾）與每 N 小時換句。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const home = require('../lib/home');
const sutraQuotes = require('../lib/sutra-quotes');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

describe('lib/home：資料夾 .md 的經句解析', () => {
  test('含全形「｜」的行才算經句；標題、空行、一般段落、表格略過', () => {
    const md = [
      '# 金剛經',
      '',
      '這是一段說明，沒有分隔符號。',
      '應無所住，而生其心。｜金剛般若波羅蜜經',
      '| 半形 | 表格 |',
      '## 華嚴',
      '- 心如工畫師，能畫諸世間。｜《大方廣佛華嚴經》',
      '> **若人欲了知**｜華嚴經｜01-大正藏/華嚴.md',
      '1. 諸惡莫作，眾善奉行。｜法句經',
      '｜只有出處沒有經句'
    ].join('\n');
    assert.deepEqual(home.parseQuoteMarkdown(md), [
      { text: '應無所住，而生其心。', source: '金剛般若波羅蜜經', path: '' },
      { text: '心如工畫師，能畫諸世間。', source: '大方廣佛華嚴經', path: '' },
      { text: '若人欲了知', source: '華嚴經', path: '01-大正藏/華嚴.md' },
      { text: '諸惡莫作，眾善奉行。', source: '法句經', path: '' }
    ]);
  });

  test('程式碼區塊與 HTML 註解裡的行不算', () => {
    const md = '```\n甲｜乙\n```\n<!--\n丙｜丁\n-->\n<!-- 戊｜己 -->\n庚｜辛';
    assert.deepEqual(home.parseQuoteMarkdown(md).map(v => v.text), ['庚']);
  });

  test('只有一個「｜」也算（經句｜出處），沒有出處也可', () => {
    assert.deepEqual(home.parseQuoteMarkdown('一切唯心造｜').map(v => v.text), ['一切唯心造']);
  });
});

describe('lib/home：合併去重', () => {
  test('標點、空白不同也算重複；先出現的（文字框）為準', () => {
    const a = [{ text: '應無所住，而生其心。', source: '金剛經', path: 'a.md' }];
    const b = [{ text: '應無所住 而生其心', source: '別處', path: '' }, { text: '心如工畫師', source: '', path: '' }];
    const m = home.mergeVerses(a, b);
    assert.equal(m.length, 2);
    assert.equal(m[0].path, 'a.md');
    assert.equal(m[1].text, '心如工畫師');
  });
});

describe('lib/home：每 N 小時換一句', () => {
  const TZ = 'Asia/Taipei';
  const at = (h, m = 0) => Date.UTC(2026, 10, 2, h - 8, m); // 台北時間 2026-11-02 h:m

  test('預設 6 小時；範圍 1–168', () => {
    assert.equal(home.normalizeRotateHours(undefined), 6);
    assert.equal(home.normalizeRotateHours('0'), 1);
    assert.equal(home.normalizeRotateHours(999), 168);
    assert.equal(home.normalizeRotateHours('12'), 12);
  });

  test('時段從網站時區午夜起算：6 小時在 0/6/12/18 點換', () => {
    const a = home.verseSlot(at(6, 0), 6, TZ);
    const b = home.verseSlot(at(11, 59), 6, TZ);
    const c = home.verseSlot(at(12, 0), 6, TZ);
    assert.equal(a.slot, b.slot);
    assert.equal(c.slot, a.slot + 1);
    assert.equal(a.nextAt, at(12, 0));
  });

  test('24 小時在當地午夜換', () => {
    const { nextAt } = home.verseSlot(at(9), 24, TZ);
    assert.equal(nextAt, Date.UTC(2026, 10, 2, 16)); // 台北 11/3 00:00
  });

  test('同一時段同一句；n 個時段內每句剛好輪到一次', () => {
    for (const n of [1, 2, 3, 7, 10, 12, 366]) {
      const seen = new Set();
      for (let s = 1000; s < 1000 + n; s++) seen.add(home.verseIndexForSlot(s, n));
      assert.equal(seen.size, n, `n=${n}`);
    }
    const list = ['a', 'b', 'c', 'd'].map(text => ({ text }));
    assert.equal(home.pickRotatingVerse(list, at(1), 6, TZ).verse, home.pickRotatingVerse(list, at(5, 59), 6, TZ).verse);
    assert.notEqual(home.pickRotatingVerse(list, at(1), 6, TZ).verse, home.pickRotatingVerse(list, at(7), 6, TZ).verse);
    assert.equal(home.pickRotatingVerse([], at(1), 6, TZ).verse, null);
  });
});

describe('lib/sutra-quotes：讀資料夾', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-quotes-'));
    fs.writeFileSync(path.join(dir, '金剛經.md'), '# 金剛經\n應無所住，而生其心。｜金剛般若波羅蜜經\n說明文字\n');
    fs.mkdirSync(path.join(dir, '華嚴'));
    fs.writeFileSync(path.join(dir, '華嚴', 'a.md'), '心如工畫師，能畫諸世間。｜大方廣佛華嚴經\n應無所住而生其心｜重複\n');
    fs.writeFileSync(path.join(dir, '.hidden.md'), '隱藏｜不該讀\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '不是md｜略過\n');
    sutraQuotes.resetCache();
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); sutraQuotes.resetCache(); });

  test('遞迴讀 .md，略過隱藏檔與非 .md，資料夾內也去重', async () => {
    const r = await sutraQuotes.getFolderVerses({ dir, force: true });
    assert.equal(r.exists, true);
    assert.deepEqual(r.files.map(f => f.file).sort(), ['華嚴/a.md', '金剛經.md'].sort());
    assert.deepEqual(r.verses.map(v => v.text).sort(), ['心如工畫師，能畫諸世間。', '應無所住，而生其心。'].sort());
  });

  test('檔案改了（mtime/大小）會重新解析', async () => {
    const f = path.join(dir, '金剛經.md');
    fs.writeFileSync(f, '一切有為法，如夢幻泡影。｜金剛經\n色即是空｜心經\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f, future, future);
    const r = await sutraQuotes.getFolderVerses({ dir, force: true });
    assert.ok(r.verses.some(v => v.text === '色即是空'));
    // 金剛經.md 不再有這句，資料夾裡剩下華嚴/a.md 那一句（原本因重複被去掉）
    assert.ok(!r.verses.some(v => v.text === '應無所住，而生其心。'));
    assert.ok(r.verses.some(v => v.source === '重複'));
  });

  test('資料夾不存在時回空，不丟錯', async () => {
    const r = await sutraQuotes.getFolderVerses({ dir: path.join(dir, 'nope'), force: true });
    assert.equal(r.exists, false);
    assert.equal(r.count, 0);
  });

  test('預設位置在 config.json 旁的 sutra-quote/，可用 SUTRA_QUOTE_DIR 改', () => {
    assert.equal(path.basename(sutraQuotes.quoteDir({})), 'sutra-quote');
    assert.equal(sutraQuotes.quoteDir({ SUTRA_QUOTE_DIR: '/srv/q' }), '/srv/q');
  });
});

describe('伺服器與後台接線', () => {
  test('suggest-list 由伺服器挑好這個時段的一句，附下次換句時間', () => {
    assert.match(serverJs, /home\.mergeVerses\(textbox, folder\.verses\)/);
    assert.match(serverJs, /verseNextAt:/);
    assert.match(serverJs, /dailyVerseRotateHours: sl\.dailyVerseRotateHours !== undefined/);
    assert.match(serverJs, /pathname === '\/api\/admin\/daily-verses'/);
    assert.match(serverJs, /async function handleAdminDailyVerses\(req, res\) \{\n  if \(!requireAdmin\(req, res, sendJSON\)\) return;/);
  });

  test('首頁用 data.verse，時段到了重抓', () => {
    assert.match(appJs, /'verse' in data \? data\.verse/);
    assert.match(appJs, /scheduleHomeVerseRefresh\(data\.verseNextAt\)/);
  });

  test('後台：換句時數、各來源筆數、狀態燈', () => {
    assert.ok(indexHtml.includes('id="suggestDailyVerseRotateHours"'));
    assert.ok(indexHtml.includes('id="dailyVerseLight"'));
    assert.ok(indexHtml.includes('id="dailyVerseTextboxCount"'));
    assert.ok(indexHtml.includes('id="dailyVerseFolderCount"'));
    assert.match(appJs, /dailyVerseRotateHours,\n/);
    assert.match(appJs, /async function loadDailyVerseStatus\(\)/);
  });
});
