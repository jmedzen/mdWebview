const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  scanText,
  normalizeLooseTerm,
  extractBigramsFromText
} = require('../lib/text.js');

describe('寬鬆模式全文搜尋與標點透明演算法測試 (Loose Search & Transparent Index)', () => {
  test('嚴格模式：scanText 不應跨標點符號命中', () => {
    const text = '世尊讚歎佛法，僧伽亦同讚歎。';
    const matches = scanText(text, ['佛法僧'], 150, false);
    assert.equal(matches.length, 0, '嚴格模式下「佛法僧」不應命中「佛法，僧」');
  });

  test('寬鬆模式：單詞忽略標點與換行比對（空白中斷相鄰）', () => {
    const terms = ['佛法僧'];

    // 1. 命中標準連續文字 '佛法僧'
    const m1 = scanText('歸依佛法僧。', terms, 150, true);
    assert.equal(m1.length, 1, '應命中「佛法僧」');
    assert.match(m1[0].snippet, /佛法僧/);

    // 2. 命中逗號分隔 '佛法，僧'
    const m2 = scanText('歸依佛法，僧伽至尊。', terms, 150, true);
    assert.equal(m2.length, 1, '應命中「佛法，僧」');
    assert.match(m2[0].snippet, /佛法，僧/);

    // 3. 命中頓號分隔 '佛、法、僧'
    const m3 = scanText('一心頂禮佛、法、僧三寶。', terms, 150, true);
    assert.equal(m3.length, 1, '應命中「佛、法、僧」');
    assert.match(m3[0].snippet, /佛、法、僧/);

    // 4. 不應命中半形空白 '佛法 僧'（空白中斷相鄰）
    const m4 = scanText('禮敬 佛法 僧 眾。', terms, 150, true);
    assert.equal(m4.length, 0, '半形空白中斷相鄰，不應命中單詞「佛法僧」');

    // 4b. 不應命中全形空格 '佛　法僧'
    const m4b = scanText('佛　法僧', terms, 150, true);
    assert.equal(m4b.length, 0, '全形空格中斷相鄰，不應命中單詞「佛法僧」');

    // 5. 命中跨行換行 '佛法\n僧'
    const m5 = scanText('大眾同心歸依佛法\n僧伽常住。', terms, 150, true);
    assert.equal(m5.length, 1, '應命中「佛法\\n僧」');

    // 6. 命中符號連字號 '佛-法-僧'
    const m6 = scanText('如是佛-法-僧寶。', terms, 150, true);
    assert.equal(m6.length, 1, '應命中「佛-法-僧」');

    // 7. 不應命中插入其他實質文字之 '佛法無邊僧'
    const m7 = scanText('佛法無邊僧伽廣大。', terms, 150, true);
    assert.equal(m7.length, 0, '中間夾帶實質文字「無邊」不應命中');

    // 8. 命中前綴複合詞 '佛法僧寶'
    const m8 = scanText('歸命常住佛法僧寶。', terms, 150, true);
    assert.equal(m8.length, 1, '應命中「佛法僧寶」');
  });

  test('多詞寬鬆模式：查詢多詞 (如「佛法 僧」) 仍以 AND 與鄰近距離命中', () => {
    const text = '世尊宣說佛法，僧伽大眾同聞。';
    const multiTerms = ['佛法', '僧'];
    const matches = scanText(text, multiTerms, 150, true);
    assert.equal(matches.length, 1, '多詞查詢「佛法 僧」在寬鬆模式下應以 AND + 鄰近成功命中');
    assert.match(matches[0].snippet, /佛法/);
    assert.match(matches[0].snippet, /僧/);
  });

  test('多詞寬鬆模式：鄰近距離 (maxProximityDist) 過濾', () => {
    const text = '南無佛陀，歸依佛法，禮敬僧伽。';
    const terms = ['佛法', '僧'];

    // 距離內 (150 chars) 應命中
    const inRange = scanText(text, terms, 150, true);
    assert.equal(inRange.length, 1, '在 150 字元鄰近距離內應成功命中');
    assert.match(inRange[0].snippet, /佛法/);
    assert.match(inRange[0].snippet, /僧/);

    // 距離外 (5 chars) 不應命中（'佛法' 到 '僧' 間距超過 5 字元）
    const outOfRange = scanText(text, terms, 5, true);
    assert.equal(outOfRange.length, 0, '超過鄰近距離視窗 (5 字元) 不應命中');
  });

  test('normalizeLooseTerm：正確去除透明符號並保留實質文字', () => {
    assert.equal(normalizeLooseTerm('佛、法、僧'), '佛法僧');
    assert.equal(normalizeLooseTerm('、、'), '');
    assert.equal(normalizeLooseTerm('\n\r\u0085\u2028\u2029'), '');
    assert.equal(normalizeLooseTerm('佛法 僧'), '佛法 僧');
    assert.equal(normalizeLooseTerm('菩薩-行深！'), '菩薩行深');
  });

  test('不變式鎖定：索引超集性質與交集非空驗證', () => {
    const bgWithPunct = extractBigramsFromText('佛法，僧');
    const bgWithoutPunct = extractBigramsFromText('佛法僧');

    // extractBigramsFromText('佛法，僧') 必含 '佛法' 與 '法僧'
    assert.ok(bgWithPunct.has('佛法'), '應包含「佛法」');
    assert.ok(bgWithPunct.has('法僧'), '跨逗號應產生「法僧」');

    // 與 extractBigramsFromText('佛法僧') 交集非空
    const intersection = [];
    for (const bg of bgWithPunct) {
      if (bgWithoutPunct.has(bg)) intersection.push(bg);
    }
    assert.ok(intersection.length > 0, '帶標點與不帶標點之 Bigram 倒排索引集合交集必須非空');
    assert.deepEqual(intersection.sort(), ['佛法', '法僧']);
  });

  test('UI 規範：#searchModeBtn 採用雙波浪近似號 ≈ 與精確等號 = 切換', () => {
    const fs = require('fs');
    const path = require('path');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const styleCss = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');

    // 1. index.html 必須含有 id="searchModeBtn" 並預設為寬鬆雙波浪圖示
    assert.match(indexHtml, /id="searchModeBtn"/, 'index.html 必須含有 searchModeBtn');
    assert.match(indexHtml, /<svg[^>]*>[\s\S]*?M2\.5 6c1\.8-2[\s\S]*?<\/svg>/, '預設 SVG 必須採用雙波浪 ≈ 圖標');
    assert.match(indexHtml, /title="寬鬆比對：已忽略標點與換行/, '按鈕標題必須明確告知寬鬆比對狀態');

    // 2. app.js 必須具備 updateSearchModeUI 並支援 ≈ 與 = 切換
    assert.match(appJs, /function updateSearchModeUI\(\)/, 'app.js 必須定義 updateSearchModeUI 函式');
    assert.match(appJs, /M3\.5 6h9/, 'app.js 精確模式下必須切換為等號 = 圖示');

    // 3. style.css 必須含有 #searchModeBtn 與 active 樣式
    assert.match(styleCss, /#searchModeBtn/, 'style.css 必須定義 #searchModeBtn 樣式');
    assert.match(styleCss, /#searchModeBtn\.active/, 'style.css 必須定義 #searchModeBtn.active 樣式');
  });
});

