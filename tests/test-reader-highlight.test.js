const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const {
  isTransparent,
  matchLooseSequence,
  scanText
} = require('../lib/text.js');

describe('閱讀區搜尋結果跳轉與寬鬆高亮演算法測試 (Reader Highlight & Jump)', () => {
  // ── [E-1] matchLooseSequence 純函式單元測試 ──
  test('matchLooseSequence：單詞忽略標點與換行比對（空白中斷相鄰）', () => {
    const terms = ['佛法僧'];

    // 1. 標準連續文字
    const r1 = matchLooseSequence('歸依佛法僧。', terms);
    assert.equal(r1.length, 1);
    assert.equal(r1[0].start, 2);
    assert.equal(r1[0].end, 5);

    // 2. 忽略標點（全形逗號）
    const r2 = matchLooseSequence('歸依佛法，僧伽至尊。', terms);
    assert.equal(r2.length, 1);
    assert.equal('歸依佛法，僧伽至尊。'.substring(r2[0].start, r2[0].end), '佛法，僧');

    // 3. 忽略換行
    const r3 = matchLooseSequence('大眾歸依佛法\n僧伽常住。', terms);
    assert.equal(r3.length, 1);
    assert.equal('大眾歸依佛法\n僧伽常住。'.substring(r3[0].start, r3[0].end), '佛法\n僧');

    // 4. 空白不透明：半形空白中斷
    const r4 = matchLooseSequence('禮敬 佛法 僧 眾。', terms);
    assert.equal(r4.length, 0, '半形空白不透明，不應命中');

    // 5. 空白不透明：全形空格中斷
    const r5 = matchLooseSequence('禮敬佛法　僧眾。', terms);
    assert.equal(r5.length, 0, '全形空格不透明，不應命中');
  });

  test('matchLooseSequence：物件序列（模擬 DOM 節點序列與虛擬跨區塊換行）', () => {
    const n1 = { id: 'node1' };
    const n2 = { id: 'node2' };
    const seq = [
      { ch: '歸', node: n1 },
      { ch: '依', node: n1 },
      { ch: '佛', node: n1 },
      { ch: '法', node: n1 },
      { ch: '，', node: n1 },
      { ch: '\n', node: null }, // 跨兄弟區塊虛擬換行
      { ch: '僧', node: n2 },
      { ch: '伽', node: n2 }
    ];

    const ranges = matchLooseSequence(seq, ['佛法僧']);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 2); // '佛'
    assert.equal(ranges[0].end, 7);   // after '僧' (start=2,3,4,5,6 -> length 5 items: 佛, 法, ，, \n, 僧)

    // 驗證跨節點項目包含 n1 與 n2
    const coveredNodes = new Set();
    for (let i = ranges[0].start; i < ranges[0].end; i++) {
      if (seq[i].node) coveredNodes.add(seq[i].node);
    }
    assert.ok(coveredNodes.has(n1), '應包含節點 1');
    assert.ok(coveredNodes.has(n2), '應包含跨區塊節點 2');
  });

  test('真實案例驗證：長老維摩詰筆錄 466 行查詢比對', () => {
    const rawParagraph = '「為護法城，受持正法」：「受持」這句話，從字面上看，「受」：領納在心叫做受；「持」是不失、不忘失、不失掉，叫做持。若用我們現在習慣上說的話，實在就是學習的意思，學習正法。學習正法，應該包括聞思修都在內的，聞、思、修。怎麼樣學習佛法呢？就是聞思修這三個方法。什麼叫做「正法」呢？';
    const query = '怎麼樣學習佛法呢就是聞思修這三個方法';

    const ranges = matchLooseSequence(rawParagraph, [query]);
    assert.equal(ranges.length, 1, '應成功命中 1 處');
    const matchedText = rawParagraph.substring(ranges[0].start, ranges[0].end);
    assert.equal(matchedText, '怎麼樣學習佛法呢？就是聞思修這三個方法', '命中字串應完整包含問號且覆蓋整句');
  });

  // ── [E-2] 透明集合一致性靜態與動態檢驗 ──
  test('透明集合定義一致性：app.js LOOSE_TRANSPARENT_RE 與 lib/text.js TRANSPARENT_RE 鏡像檢驗', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    const textContent = fs.readFileSync(path.join(ROOT_DIR, 'lib/text.js'), 'utf8');

    // 擷取 lib/text.js 中的 TRANSPARENT_RE
    const textMatch = textContent.match(/TRANSPARENT_RE\s*=\s*(\/[^/]+\/[a-z]*);/);
    assert.ok(textMatch, 'lib/text.js 應包含 TRANSPARENT_RE 定義');
    const textRegexStr = textMatch[1];

    // 擷取 app.js 中的 LOOSE_TRANSPARENT_RE
    const appMatch = appContent.match(/LOOSE_TRANSPARENT_RE\s*=\s*(\/[^/]+\/[a-z]*);/);
    assert.ok(appMatch, 'app.js 應包含 LOOSE_TRANSPARENT_RE 定義');
    const appRegexStr = appMatch[1];

    assert.equal(
      appRegexStr,
      textRegexStr,
      'app.js 的 LOOSE_TRANSPARENT_RE 必須與 lib/text.js 的 TRANSPARENT_RE 完全相同'
    );

    // 執行期字元動態抽樣一致性檢驗
    const testChars = [
      '，', '。', '！', '？', '；', '：', '「', '」', '『', '』',
      '（', '）', '【', '】', '《', '》', '—', '…', '、', '\n', '\r',
      '\u0085', '\u2028', '\u2029',
      // 非透明字元（不可被判定為透明）
      ' ', '\t', '\u3000', '\u00A0', '佛', '法', '僧', 'a', '1'
    ];

    const appRe = eval(appRegexStr);
    for (const ch of testChars) {
      const appResult = appRe.test(ch);
      const textResult = isTransparent(ch);
      assert.equal(
        appResult,
        textResult,
        `字元 ${JSON.stringify(ch)} (code: ${ch.charCodeAt(0)}) 在前端與後端判定必須一致`
      );
    }
  });

  // ── [E-3] 閱讀區高亮與嚴格模式行為檢驗 ──
  test('app.js 閱讀區高亮與跳轉架構完整性靜態斷言', () => {
    const appContent = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');

    // 1. highlightLineKeyword 接受 searchMode 參數並區分 loose / strict
    assert.match(
      appContent,
      /function\s+highlightLineKeyword\s*\(\s*anchorEl\s*,\s*query\s*,\s*searchMode\s*\)/,
      'highlightLineKeyword 應接受 anchorEl, query, searchMode 三個參數'
    );
    assert.match(
      appContent,
      /if\s*\(\s*mode\s*!==\s*['"]loose['"]\s*\)/,
      '嚴格模式必須維持獨立條件分支'
    );

    // 2. 嚴格模式保留字面比對 (escRegex, 字面 RegExp) 與 .line-anchor 邊界
    assert.match(
      appContent,
      /escRegex[\s\S]*?new\s+RegExp\(`\(\$\{regexPattern\}\)`,\s*['"]gi['"]\)/,
      '嚴格模式必須維持字面 regex 比對'
    );

    // 3. 寬鬆模式使用有界兄弟區塊走訪 (windowBlocks, TreeWalker, LOOSE_TRANSPARENT_RE)
    assert.match(
      appContent,
      /windowBlocks[\s\S]*?createTreeWalker/,
      '寬鬆模式必須建立連續區塊窗口並以 TreeWalker 走訪文字節點'
    );

    // 4. 跳轉目標落在含有命中的區塊 (hitBlock) 且無命中時 fallback 至原 anchor
    assert.match(
      appContent,
      /if\s*\(\s*hlRes\s*&&\s*hlRes\.matched\s*\)\s*\{[\s\S]*?flashBlock\s*=\s*hlRes\.hitBlock[\s\S]*?scrollTarget\s*=\s*hlRes\.firstMark\s*\|\|\s*hlRes\.hitBlock/,
      '命中時應以 hitBlock 與 firstMark 作為閃示與捲動目標'
    );

    // 5. 修正捲動定位：佈局未定時量測 (requestAnimationFrame) 重算捲動位置
    assert.match(
      appContent,
      /requestAnimationFrame\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?getBoundingClientRect[\s\S]*?safeScrollToElement/,
      'scrollToLine 應在插入高亮後使用 requestAnimationFrame 檢查並修正捲動偏移'
    );

    // 6. openFile 與點擊處理器正確帶入 searchMode
    assert.match(
      appContent,
      /async\s+function\s+openFile\s*\(\s*filePath\s*,\s*scrollToLineNum\s*,\s*highlightQuery\s*,\s*searchMode\s*\)/,
      'openFile 簽名應支援 searchMode'
    );
    assert.match(
      appContent,
      /openFile\(file,\s*line\s*\?\s*parseInt\(line,\s*10\)\s*:\s*null,\s*query,\s*searchMode\)/,
      '點擊搜尋結果時應傳遞 searchMode 至 openFile'
    );
  });
});
