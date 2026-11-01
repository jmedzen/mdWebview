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

  test('公告最多顯示三行，可展開', () => {
    const m = styleCss.match(/\.home-notice-text\s*\{[^}]*\}/);
    assert.ok(m, '找不到 .home-notice-text');
    assert.match(m[0], /-webkit-line-clamp:\s*3/);
    assert.match(styleCss, /\.home-notice\.expanded\s+\.home-notice-text/);
  });

  test('收起公告沿用舊的知曉 key，公告改字才會再出現', () => {
    assert.match(appJs, /const HOME_NOTICE_KEY = STORAGE_KEYS\.ANNOUNCEMENT_ACK;/);
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
