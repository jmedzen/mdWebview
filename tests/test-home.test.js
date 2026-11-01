/**
 * 首頁（晨嵐，無彈窗）：每日經文、辭典釋義摘要、問候與節氣、公告一行。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const home = require('../lib/home');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');

// 從 app.js 取出首頁的日期／經句小工具，獨立執行
function loadHomeHelpers() {
  const start = appJs.indexOf('  const CN_DIGITS');
  const endMarker = 'function verseLines(text) {';
  const endStart = appJs.indexOf(endMarker);
  assert.ok(start > 0 && endStart > start, '找不到首頁小工具區段');
  const end = appJs.indexOf('\n  }\n', endStart) + 4;
  // eslint-disable-next-line no-new-func
  return new Function(`${appJs.slice(start, end)}
    return { cnNumber, homeGreeting, solarTermDay, currentSolarTerm, homeDateLine, localDayIndex, pickDailyVerse, verseLines };`)();
}

describe('lib/home：每日經文清單', () => {
  test('預設清單有七句，每句都有出處', () => {
    assert.equal(home.DEFAULT_DAILY_VERSES.length, 7);
    for (const v of home.DEFAULT_DAILY_VERSES) {
      assert.ok(v.text.length > 0);
      assert.ok(v.source.length > 0);
    }
  });

  test('一行一句，全形／半形分隔都接受；空行與 # 開頭略過；書名號會去掉', () => {
    const list = home.parseVerses([
      '# 註解',
      '',
      '應無所住，而生其心。｜《金剛經》',
      '色即是空 | 心經 | 01-大正藏/03般若部類/T0251.md',
      '只有經句'
    ].join('\n'));
    assert.deepEqual(list, [
      { text: '應無所住，而生其心。', source: '金剛經', path: '' },
      { text: '色即是空', source: '心經', path: '01-大正藏/03般若部類/T0251.md' },
      { text: '只有經句', source: '', path: '' }
    ]);
  });

  test('文字框 ⇄ 陣列 來回一致', () => {
    const text = '甲｜乙｜a/b.md\n丙｜丁\n戊';
    assert.equal(home.versesToText(home.parseVerses(text)), text);
  });

  test('過長的欄位會截斷，句數上限 366', () => {
    const [v] = home.parseVerses('字'.repeat(500) + '｜' + '經'.repeat(100));
    assert.equal(v.text.length, 200);
    assert.equal(v.source.length, 60);
    const many = home.parseVerses(Array.from({ length: 400 }, (_, i) => `句${i}`).join('\n'));
    assert.equal(many.length, home.MAX_VERSES);
  });

  test('陣列輸入（匯入備份）也會清理', () => {
    assert.deepEqual(home.parseVerses([{ text: ' 甲 ', source: '《乙》' }, { text: '' }, '丙']), [
      { text: '甲', source: '乙', path: '' },
      { text: '丙', source: '', path: '' }
    ]);
  });

  test('從未設定時用預設清單；管理員清空就是不顯示', () => {
    assert.equal(home.resolveVerses(undefined).length, 7);
    assert.equal(home.resolveVerses(null).length, 7);
    assert.deepEqual(home.resolveVerses([]), []);
    assert.deepEqual(home.resolveVerses(''), []);
  });
});

describe('lib/home：辭典釋義摘要', () => {
  test('去掉標題、連結、強調、HTML 與註腳', () => {
    const md = '## 布施\n\n**布施**是[六度](x.md)之一，見 [[六度|六波羅蜜]]。<br>又名<span>檀那</span>[^1]。';
    assert.equal(home.excerptFromMarkdown(md), '布施是六度之一，見 六波羅蜜。又名檀那。');
  });

  test('超過字數時截斷並加刪節號', () => {
    const s = home.excerptFromMarkdown('甲'.repeat(100), 10);
    assert.equal(s, '甲'.repeat(10) + '…');
  });

  test('依位元組位置讀出條目；讀不到時回空字串', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-home-'));
    const file = path.join(dir, 'dict.md');
    const head = '# 辭典\n\n';
    const entry = '## 布施\n\n以財物、佛法施予他人。\n\n';
    fs.writeFileSync(file, head + entry + '## 持戒\n\n守持戒律。\n');
    const offset = Buffer.byteLength(head);
    const len = Buffer.byteLength(entry);
    assert.equal(await home.readDictExcerpt(file, offset, len), '以財物、佛法施予他人。');
    assert.equal(await home.readDictExcerpt(path.join(dir, 'missing.md'), 0, 10), '');
    assert.equal(await home.readDictExcerpt(file, NaN, 10), '');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('首頁：問候、日期與節氣', () => {
  const h = loadHomeHelpers();

  test('中文日期數字', () => {
    assert.deepEqual([1, 10, 11, 20, 23, 31].map(h.cnNumber), ['一', '十', '十一', '二十', '二十三', '三十一']);
  });

  test('早安／午安／晚安', () => {
    assert.equal(h.homeGreeting(4), '晚安');
    assert.equal(h.homeGreeting(5), '早安');
    assert.equal(h.homeGreeting(11), '午安');
    assert.equal(h.homeGreeting(18), '晚安');
  });

  test('2026 年節氣日期與曆書一致', () => {
    const day = name => h.solarTermDay(2026, ['小寒', '大寒', '立春', '雨水', '驚蟄', '春分', '清明', '穀雨',
      '立夏', '小滿', '芒種', '夏至', '小暑', '大暑', '立秋', '處暑', '白露', '秋分', '寒露', '霜降',
      '立冬', '小雪', '大雪', '冬至'].indexOf(name));
    assert.equal(day('小寒'), 5);
    assert.equal(day('立春'), 4);
    assert.equal(day('清明'), 5);
    assert.equal(day('夏至'), 21);
    assert.equal(day('霜降'), 23);
    assert.equal(day('立冬'), 7);
    assert.equal(day('冬至'), 22);
  });

  test('目前節氣：當天起算，年初接續上一年冬至', () => {
    assert.equal(h.currentSolarTerm(new Date(2026, 10, 1)), '霜降');
    assert.equal(h.currentSolarTerm(new Date(2026, 10, 7)), '立冬');
    assert.equal(h.currentSolarTerm(new Date(2026, 0, 2)), '冬至');
    assert.equal(h.currentSolarTerm(new Date(2026, 0, 5)), '小寒');
  });

  test('日期列', () => {
    assert.equal(h.homeDateLine(new Date(2026, 10, 1)), '十一月一日 星期日 · 霜降');
  });

  test('每日經文：同一天固定，換日輪替，空清單回 null', () => {
    const verses = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    const morning = h.pickDailyVerse(verses, new Date(2026, 10, 1, 6));
    assert.equal(h.pickDailyVerse(verses, new Date(2026, 10, 1, 23)), morning);
    assert.notEqual(h.pickDailyVerse(verses, new Date(2026, 10, 2, 6)), morning);
    assert.equal(h.pickDailyVerse([], new Date()), null);
    assert.equal(h.pickDailyVerse(undefined, new Date()), null);
  });
});

describe('首頁：經句分兩行', () => {
  const h = loadHomeHelpers();

  test('在中間的分句邊界斷開', () => {
    assert.deepEqual(h.verseLines('諸惡莫作，諸善奉行，自淨其意，是諸佛教。'), ['諸惡莫作，諸善奉行，', '自淨其意，是諸佛教。']);
    assert.deepEqual(h.verseLines('色不異空，空不異色；色即是空，空即是色。'), ['色不異空，空不異色；', '色即是空，空即是色。']);
    assert.deepEqual(h.verseLines('應無所住，而生其心。'), ['應無所住，而生其心。']);
    assert.deepEqual(h.verseLines('若人欲了知，三世一切佛，應觀法界性，一切唯心造。'), ['若人欲了知，三世一切佛，', '應觀法界性，一切唯心造。']);
  });

  test('沒有標點的長句不拆', () => {
    assert.deepEqual(h.verseLines('一二三四五六七八九十十一十二'), ['一二三四五六七八九十十一十二']);
  });
});

// 取出單一函式原始碼（到同層的「\n  }\n」為止）
function fnSource(name) {
  const start = appJs.indexOf(`  function ${name}(`);
  assert.ok(start > 0, `找不到 ${name}`);
  return appJs.slice(start, appJs.indexOf('\n  }\n', start) + 4);
}

describe('首頁：搜尋與書架', () => {
  // eslint-disable-next-line no-new-func
  const h = new Function(['bookSlipTitle', 'bookTone', 'homeSearchKey', 'homeTitleMatches'].map(fnSource).join('\n')
    + '\nreturn { bookSlipTitle, bookTone, homeSearchKey, homeTitleMatches };')();

  test('題簽取書名號內的經名；沒有書名號時去掉經號', () => {
    assert.equal(h.bookSlipTitle('T0251《般若波羅蜜多心經》'), '般若波羅蜜多心經');
    assert.equal(h.bookSlipTitle('X1234a 金剛經疏'), '金剛經疏');
    assert.equal(h.bookSlipTitle('金剛般若經贊述釋記3'), '金剛般若經贊述釋記3');
  });

  test('封面色依路徑固定，介於 0–4', () => {
    const t = h.bookTone('a/b.md');
    assert.equal(h.bookTone('a/b.md'), t);
    assert.ok(t >= 0 && t <= 4);
  });

  test('經名比對：去掉書名號與空白、多詞都要出現、經名開頭相符的排前面', () => {
    const files = [
      { name: 'T1579《瑜伽師地論》', folder: '14瑜伽部類' },
      { name: 'T0251《般若波羅蜜多心經》', folder: '03般若部類' },
      { name: 'T0220《大般若波羅蜜多經》', folder: '03般若部類' }
    ].map(f => ({ ...f, path: f.name + '.md', key: h.homeSearchKey(f.name + ' ' + f.folder) }));
    assert.deepEqual(h.homeTitleMatches(files, '般若').map(f => f.name), ['T0251《般若波羅蜜多心經》', 'T0220《大般若波羅蜜多經》']);
    assert.deepEqual(h.homeTitleMatches(files, '般若 心經').map(f => f.name), ['T0251《般若波羅蜜多心經》']);
    assert.deepEqual(h.homeTitleMatches(files, '《瑜伽》').map(f => f.name), ['T1579《瑜伽師地論》']);
    assert.deepEqual(h.homeTitleMatches(files, '  '), []);
  });

  test('首頁有搜尋框、隨手翻一卷、我的書架', () => {
    for (const id of ['homeSearch', 'homeSearchInput', 'homeSearchResults', 'homeRandom', 'homeBrowse', 'homeShelf']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `缺少 #${id}`);
    }
  });
});

describe('首頁：沒有彈窗，公告在首頁一行', () => {
  test('每日訊息彈窗已移除', () => {
    assert.ok(!indexHtml.includes('announcementModalOverlay'));
    assert.ok(!appJs.includes('announcementModalOverlay'));
    assert.ok(!styleCss.includes('.announcement-modal'));
  });

  test('首頁區塊都在', () => {
    for (const id of ['homeGreet', 'homeVerse', 'homeContinue', 'homeNotice', 'homeNoticeMore', 'homeNoticeClose', 'homeWord', 'suggestList']) {
      assert.ok(indexHtml.includes(`id="${id}"`), `缺少 #${id}`);
    }
  });

  test('公告一則一行，預設只列前三則，可展開全部', () => {
    assert.match(styleCss, /\.home-notice:not\(\.expanded\)\s+\.home-notice-item:nth-child\(n \+ 4\)\s*\{[^}]*display:\s*none/);
    assert.match(appJs, /const HOME_NOTICE_COLLAPSED = 3;/);
    assert.ok(indexHtml.includes('id="homeNoticeDate"'));
  });

  test('首頁公告用自己的收起紀錄（不沿用舊彈窗的知曉紀錄），收起後可再顯示', () => {
    assert.match(appJs, /const HOME_NOTICE_KEY = STORAGE_KEYS\.HOME_NOTICE_DISMISSED;/);
    assert.match(appJs, /HOME_NOTICE_DISMISSED: 'mdWebview-home-notice-dismissed'/);
    assert.ok(indexHtml.includes('id="homeNoticeReopen"'));
  });

  test('/api/suggest-list 帶每日經文；後台可存經文清單', () => {
    assert.match(serverJs, /verses: home\.resolveVerses\(/);
    assert.match(serverJs, /dailyVerses: sl\.dailyVerses !== undefined \? home\.parseVerses\(sl\.dailyVerses\)/);
    assert.ok(indexHtml.includes('id="suggestDailyVerses"'));
  });

  test('每日一詞不再放「看完整條目」（詞條標題本身可點）', () => {
    assert.ok(!appJs.includes('看完整條目'));
  });
});

// ── 首頁「入室」版面（v4.8.0）──────────────────────────────────
describe('首頁：入室版面', () => {
  test('第一屏撐滿視窗；向下提示在 hero 裡，下面沒內容時隱藏', () => {
    assert.match(styleCss, /\.home-hero \{[^}]*min-height: calc\(100svh - 70px\)/);
    assert.ok(indexHtml.includes('id="homeScrollCue"'));
    assert.match(appJs, /function homeBelowTarget\(\)/);
    assert.match(appJs, /cue\.hidden = !homeBelowTarget\(\)/);
  });

  test('經句與區塊標題同為粗宋體', () => {
    const verse = styleCss.match(/\.home-verse-text \{[^}]*font-family: var\(--cjk-serif\)[^}]*font-weight: 600/);
    assert.ok(verse, '經句應使用 --cjk-serif、字重 600');
    assert.match(styleCss, /\.home-sec-title \{[^}]*font-family: var\(--cjk-serif\)[^}]*font-weight: 600/);
  });

  test('手機書架改成大按鈕清單：每列 ≥72px、整列可點、桌機隱藏', () => {
    assert.match(appJs, /class="home-shelf-list"/);
    assert.match(appJs, /class="home-item\$\{i === 0 \? ' is-latest' : ''\}"[^`]*data-file=/);
    assert.match(styleCss, /\.home-item \{[^}]*min-height: 72px/);
    assert.match(styleCss, /\.home-shelf-list \{\s*display: none;/);
    const mobile = styleCss.slice(styleCss.lastIndexOf('@media (max-width: 768px) {', styleCss.indexOf('.welcome-footer {')));
    assert.match(mobile, /\.home-shelf-stage,\s*\.home-shelf-info \{\s*display: none;/);
    assert.match(mobile, /\.home-shelf-list \{\s*display: flex;/);
  });

  test('書本是淡色粉彩，書名用深墨色（不再是深色書衣＋白字）', () => {
    assert.doesNotMatch(styleCss, /#6e3b2b|#3c5547|#2d4060/);
    assert.match(styleCss, /\.home-spine-title \{[^}]*color: rgba\(52, 44, 36/);
  });

  test('蓮花仍是會漂浮的 emoji', () => {
    assert.ok(indexHtml.includes('<div class="welcome-lotus" aria-hidden="true">🪷</div>'));
    assert.match(styleCss, /\.welcome-lotus \{[^}]*animation: float/);
    // 桌機 60px，手機 48px
    assert.match(styleCss, /\.home-hero\.has-verse \.welcome-lotus \{\s*font-size: 60px;\s*margin-bottom: 8px;/);
    assert.match(styleCss, /@media \(max-width: 768px\) \{\s*\.home-hero \{\s*padding: 84px 0 110px;\s*\}\s*\.home-hero\.has-verse \.welcome-lotus \{\s*font-size: 48px;/);
  });
});

describe('首頁：書架短經名', () => {
  function loadBookSlipTitle() {
    const start = appJs.indexOf('  function bookSlipTitle(title) {');
    const end = appJs.indexOf('\n  }\n', start) + 4;
    assert.ok(start > 0 && end > start);
    // eslint-disable-next-line no-new-func
    return new Function(`${appJs.slice(start, end)}\n    return bookSlipTitle;`)();
  }

  test('有書名號取書名號；有經號＋經名去經號', () => {
    const f = loadBookSlipTitle();
    assert.equal(f('T0251《般若波羅蜜多心經》'), '般若波羅蜜多心經');
    assert.equal(f('X1234a 楞嚴經正脈疏'), '楞嚴經正脈疏');
    assert.equal(f('T0262_妙法蓮華經'), '妙法蓮華經');
  });

  test('檔名本身就是編號時整段保留（「80-01」不能只剩「01」）', () => {
    const f = loadBookSlipTitle();
    assert.equal(f('80-01'), '80-01');
    assert.equal(f('T0251'), 'T0251');
    assert.equal(f('12.3'), '12.3');
    assert.equal(f('  '), '');
  });
});

describe('首頁：每日一詞「換一個」', () => {
  test('其他候選詞條是有邊框的按鈕（≥40px），不是句子裡的小字連結', () => {
    assert.match(appJs, /class="home-word-others-label">換一個</);
    assert.match(appJs, /class="home-word-chips">/);
    assert.match(styleCss, /\.home-word-alt \{[^}]*min-height: 40px[^}]*border: 1px solid var\(--border\)[^}]*border-radius: 999px/);
    assert.doesNotMatch(appJs, /換一個：\$\{others/);
  });
});
