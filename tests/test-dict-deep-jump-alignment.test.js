const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');

// app.js 是 IIFE，無法 import，故沿用專案既有慣例以原始碼靜態斷言守護架構契約
// （同 tests/test-reader-highlight.test.js、tests/test-media-lightbox.test.js）。
const appContent = fs.readFileSync(APP_JS, 'utf8');

// 取得 scrollToLineVirtual 的函式主體，讓斷言限定在該函式內，避免跨函式誤匹配。
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  // 由簽名往後掃描，以大括號配對找出函式結尾（忽略字串／註解中的括號已足夠，
  // 因為本檔僅用於結構斷言）。
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

describe('辭典深層結果跳轉定位：以要求行的 anchor 為準 (Deep Jump Alignment)', () => {
  const virtualBody = extractFunctionBody(appContent, 'async function scrollToLineVirtual(');
  const fullBody = extractFunctionBody(appContent, 'function scrollToLine(');

  test('可擷取兩條跳轉路徑的函式主體（防斷言因抽取失敗而空洞化）', () => {
    assert.ok(virtualBody, '應能擷取 scrollToLineVirtual 函式主體');
    assert.ok(fullBody, '應能擷取 scrollToLine 函式主體');
    assert.ok(virtualBody.length > 500, 'scrollToLineVirtual 主體長度應合理');
    assert.ok(fullBody.length > 500, 'scrollToLine 主體長度應合理');
  });

  // ── [核心契約] 捲動定位必須用 target，不可用 firstMark ──
  test('捲動目標一律為 target：兩條路徑皆不得以 firstMark 定位', () => {
    for (const [name, body] of [['scrollToLineVirtual', virtualBody], ['scrollToLine', fullBody]]) {
      assert.doesNotMatch(
        body,
        /scrollTarget\s*=\s*hlRes\.firstMark/,
        `${name} 不得以 firstMark 作為捲動目標（寬鬆模式高亮視窗向前納入兄弟區塊，` +
          'firstMark 可能位在要求行之前，會造成大檔後段跳轉錯位）'
      );
      assert.match(
        body,
        /scrollTarget\s*=\s*target;/,
        `${name} 應以 target（要求行的 anchor）作為捲動目標`
      );
    }
  });

  test('全檔不得殘留以 firstMark 定位的寫法', () => {
    assert.doesNotMatch(
      appContent,
      /scrollTarget\s*=\s*hlRes\.firstMark/,
      'app.js 全檔不得再出現 scrollTarget = hlRes.firstMark'
    );
  });

  // ── [閃示] hitBlock 仍須用於閃示，避免修復時誤刪關鍵字提示 ──
  test('命中時仍以 hitBlock 作為閃示目標（關鍵字提示不得回歸）', () => {
    for (const [name, body] of [['scrollToLineVirtual', virtualBody], ['scrollToLine', fullBody]]) {
      assert.match(
        body,
        /hlRes\s*&&\s*hlRes\.matched\s*\)\s*\{\s*flashBlock\s*=\s*hlRes\.hitBlock;/,
        `${name} 命中時應將 flashBlock 設為 hlRes.hitBlock`
      );
      assert.match(
        body,
        /flashBlock\.classList\.add\('line-highlight'\)/,
        `${name} 應保留 line-highlight 閃示`
      );
    }
  });

  // ── [有界修正] 事後修正迴圈與其守衛條件 ──
  test('scrollToLineVirtual 具備有界的 anchor 事後修正迴圈', () => {
    assert.match(virtualBody, /const alignJump\s*=\s*\(attempt\)\s*=>/, '應定義 alignJump 修正函式');
    assert.match(virtualBody, /requestAnimationFrame\(\(\)\s*=>\s*\{\s*v\._lineJumpRaf\s*=\s*null;\s*alignJump\(0\);\s*\}\)/,
      '應以 requestAnimationFrame 啟動第一次修正');
    assert.match(virtualBody, /alignJump\(attempt\s*\+\s*1\)/, '修正應以 attempt + 1 遞迴並受次數上限約束');
    assert.match(virtualBody, /attempt\s*>=\s*3/, '修正次數必須有上限（避免無限迴圈）');
  });

  test('修正迴圈具備文件切換與節點卸載守衛', () => {
    assert.match(virtualBody, /state\.virtual\s*!==\s*v/, '應比對 state.virtual 身分，避免對已卸載文件捲動');
    assert.match(virtualBody, /const jumpToken\s*=\s*state\._openToken;/, '應於進入時捕捉 _openToken');
    assert.match(virtualBody, /state\._openToken\s*!==\s*jumpToken/, '應偵測文件切換並中止修正');
    assert.match(virtualBody, /target\.isConnected/, '應確認 target 仍在文件樹中');
  });

  test('修正迴圈具備無進展（震盪）與捲動邊界終止條件', () => {
    assert.match(virtualBody, /abs\s*>=\s*lastAbs/, '應在誤差未再縮小時中止（防震盪）');
    assert.match(virtualBody, /abs\s*<=\s*2/, '應在誤差足夠小時收斂停止');
    assert.match(virtualBody, /next\s*===\s*c\.scrollTop/, '應在已達捲動邊界時視為終止');
  });

  // ── [最危險的回歸] 迴圈內不得重新解析 anchor ──
  test('修正迴圈內不得重新呼叫 anchorAtOrBefore（否則切換檔案後會甩到文末）', () => {
    const alignStart = virtualBody.indexOf('const alignJump');
    assert.ok(alignStart !== -1, '應能找到 alignJump');
    const alignBody = virtualBody.slice(alignStart);
    assert.doesNotMatch(
      alignBody,
      /anchorAtOrBefore\s*\(/,
      'alignJump 內不得重新解析 anchor：切換檔案後殘留影格會對新文件取到最後一個 ' +
        'anchor，實測會將 scrollTop 甩到文末'
    );
    assert.doesNotMatch(
      alignBody,
      /getElementById\(\s*'L'\s*\+/,
      'alignJump 內不得重新查詢 L<lineNum>，應重複使用迴圈外已解析的 target'
    );
    // target 必須在迴圈外解析完成
    assert.match(
      virtualBody,
      /let target = document\.getElementById\('L' \+ lineNum\);/,
      'target 應在修正迴圈之前解析一次'
    );
  });

  // ── [rAF 欄位隔離與生命週期] ──
  test('使用獨立的 _lineJumpRaf 欄位，並在 teardownVirtual 取消', () => {
    assert.match(appContent, /v\._lineJumpRaf\s*=\s*requestAnimationFrame/, '應將影格 id 存於 v._lineJumpRaf');
    assert.doesNotMatch(
      virtualBody,
      /v\._scrollRaf\s*=/,
      '不得重用 v._scrollRaf（那是 setupVirtualScroll 的節流閘門，重用會抑制 onScroll）'
    );
    const teardownBody = extractFunctionBody(appContent, 'function teardownVirtual(');
    assert.ok(teardownBody, '應能擷取 teardownVirtual 函式主體');
    assert.match(
      teardownBody,
      /if\s*\(v\._lineJumpRaf\)\s*\{\s*cancelAnimationFrame\(v\._lineJumpRaf\);\s*v\._lineJumpRaf\s*=\s*null;\s*\}/,
      'teardownVirtual 應取消待執行的行跳轉修正影格'
    );
  });

  // ── [未破壞高亮演算法] ──
  test('highlightLineKeyword 的寬鬆模式區塊走訪契約維持不變', () => {
    assert.match(appContent, /windowBlocks[\s\S]{0,400}?createTreeWalker/,
      '寬鬆模式應維持連續區塊窗口 + TreeWalker 走訪');
    assert.match(appContent, /function\s+highlightLineKeyword\s*\(\s*anchorEl\s*,\s*query\s*,\s*searchMode\s*\)/,
      'highlightLineKeyword 簽名不得變動');
  });

  // ── [閱讀進度還原不得干擾虛擬檔案跳轉] ──
  // restoreReadProgress 原本只用檔案大小判斷是否為虛擬檔案，但字典檔（dict:）
  // 不在 /api/tree 的 fileSizes 對照表中，因此會對字典檔補送延遲的
  // content.scrollTo，覆蓋 openFile 剛完成的行號定位。實測（CDP A/B）：舊寫法
  // 開啟 dict: 檔案時發出 2 次指向過期 scrollTop 的捲動，新寫法為 0 次。
  describe('閱讀進度還原不得對虛擬檔案補送 scrollTo', () => {
    const restoreBody = extractFunctionBody(appContent, 'function restoreReadProgress(');

    test('可擷取 restoreReadProgress 函式主體', () => {
      assert.ok(restoreBody, '應能擷取 restoreReadProgress 函式主體');
    });

    test('使用 isVirtualizedFile 判斷，而非只看檔案大小', () => {
      assert.match(restoreBody, /if\s*\(isVirtualizedFile\(data\.filePath\)\)\s*return;/,
        'restoreReadProgress 應以 isVirtualizedFile() 判斷是否為虛擬檔案');
      assert.doesNotMatch(
        restoreBody,
        /state\.fileSizes\.get\(data\.filePath\)[^\n]*LARGE_FILE_MIN_BYTES/,
        '不得只用檔案大小判斷：字典檔不在 fileSizes 中，會被誤判為非虛擬檔案'
      );
    });

    test('isVirtualizedFile 將 dict: 檔案一律視為虛擬', () => {
      const helper = extractFunctionBody(appContent, 'function isVirtualizedFile(');
      assert.ok(helper, '應定義 isVirtualizedFile 輔助函式');
      assert.match(helper, /startsWith\('dict:'\)/,
        'isVirtualizedFile 應把 dict: 檔案視為虛擬');
      assert.match(helper, /state\.fileSizes\.get\(filePath\)[\s\S]{0,80}?LARGE_FILE_MIN_BYTES/,
        'isVirtualizedFile 仍應涵蓋大型檔案的大小判斷');
    });

    test('延遲捲動具備文件切換守衛', () => {
      assert.match(restoreBody, /const restoreToken\s*=\s*state\._openToken;/,
        '應在 openFile 完成後捕捉 _openToken');
      const guards = restoreBody.match(/state\._openToken !== restoreToken/g) || [];
      assert.ok(guards.length >= 2,
        '兩個延遲回呼都應比對 _openToken，避免對已切換的文件捲動');
      assert.match(restoreBody, /state\.currentFile !== data\.filePath/,
        '應同時比對 currentFile');
    });

    test('捕捉 token 必須在 openFile 之後（openFile 自身會遞增 _openToken）', () => {
      const openIdx = restoreBody.indexOf('openFile(data.filePath, data.line)');
      const tokIdx = restoreBody.indexOf('const restoreToken');
      assert.ok(openIdx !== -1 && tokIdx !== -1, '應同時存在 openFile 呼叫與 token 捕捉');
      assert.ok(tokIdx > openIdx,
        'restoreToken 必須在 openFile 呼叫之後才捕捉，否則必定與最新的 _openToken 不符，' +
        '導致一般檔案的閱讀進度還原永遠失效');
      assert.doesNotMatch(restoreBody, /\+\+state\._openToken/,
        'restoreReadProgress 不得自行遞增 _openToken');
    });
  });
});
