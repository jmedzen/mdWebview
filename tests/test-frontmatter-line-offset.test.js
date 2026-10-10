const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { stripFrontmatter } = require('../lib/markdown.js');
const { renderWithWorker, terminateWorkerPools } = require('../lib/worker-pool.js');

describe('YAML Frontmatter 行號偏移計算與渲染錨點對齊測試 (Frontmatter Line Offset)', () => {
  // renderWithWorker 會啟動 Worker Thread Pool；必須在測試結束後關閉，否則 Worker Thread
  // 會讓 event loop 保持存活，node --test 永遠不會退出（與 test-server-api.test.js 相同處理）。
  after(async () => {
    if (typeof terminateWorkerPools === 'function') {
      await terminateWorkerPools();
    }
  });

  describe('1. stripFrontmatter 純函式單元驗證', () => {
    test('無 frontmatter 文本（偏移量應為 0）', () => {
      const text = '# 標題\n正文第一行\n正文第二行';
      const result = stripFrontmatter(text);
      assert.equal(result.lineOffset, 0);
      assert.equal(result.body, text);
      assert.deepEqual(result.frontmatter, {});
    });

    test('標準 LF 換行 9 行 frontmatter（被剝離前綴行數為 9）', () => {
      const text = [
        '---',
        'title: 測試經文',
        '講者: 玅境長老',
        '經名: 維摩詰經',
        '品次: 佛國品第一',
        '類型: 筆錄',
        '年份: 1993',
        '地點: 美國法雲寺',
        '---',
        '這是第10行段落。',
        '這是第11行段落。'
      ].join('\n');

      const result = stripFrontmatter(text);
      assert.equal(result.lineOffset, 9, '9 行 frontmatter 應計算出 lineOffset = 9');
      assert.equal(result.body, '這是第10行段落。\n這是第11行段落。');
      assert.equal(result.frontmatter.title, '測試經文');
      assert.equal(result.frontmatter.講者, '玅境長老');
      assert.equal(result.frontmatter.經名, '維摩詰經');
      assert.equal(result.frontmatter.品次, '佛國品第一');
      assert.equal(result.frontmatter.類型, '筆錄');
      assert.equal(result.frontmatter.年份, '1993');
      assert.equal(result.frontmatter.地點, '美國法雲寺');
    });

    test('CRLF 換行 9 行 frontmatter（被剝離前綴行數為 9）', () => {
      const text = [
        '---',
        'title: CRLF測試',
        '講者: 玅境長老',
        '經名: 維摩詰經',
        '品次: 佛國品第一',
        '類型: 筆錄',
        '年份: 1993',
        '地點: 美國法雲寺',
        '---',
        'CRLF正文第10行。',
        'CRLF正文第11行。'
      ].join('\r\n');

      const result = stripFrontmatter(text);
      assert.equal(result.lineOffset, 9, 'CRLF 9 行 frontmatter 應計算出 lineOffset = 9');
      assert.equal(result.body, 'CRLF正文第10行。\r\nCRLF正文第11行。');
      assert.equal(result.frontmatter.title, 'CRLF測試');
      assert.equal(result.frontmatter.年份, '1993');
    });

    test('未閉合的 frontmatter（不剝離，偏移量應為 0）', () => {
      const text = '---\ntitle: 未閉合\n講者: 測試\n這裡沒有結尾標記';
      const result = stripFrontmatter(text);
      assert.equal(result.lineOffset, 0);
      assert.equal(result.body, text);
      assert.deepEqual(result.frontmatter, {});
    });

    test('空字串與非法型別輸入防禦', () => {
      assert.deepEqual(stripFrontmatter(''), { body: '', frontmatter: {}, lineOffset: 0 });
      assert.deepEqual(stripFrontmatter(null), { body: '', frontmatter: {}, lineOffset: 0 });
      assert.deepEqual(stripFrontmatter(undefined), { body: '', frontmatter: {}, lineOffset: 0 });
    });

    test('含有引號包裹值的 frontmatter', () => {
      const text = '---\ntitle: "維摩詰所說經"\nauthor: \'鳩摩羅什\'\n---\n內文';
      const result = stripFrontmatter(text);
      assert.equal(result.lineOffset, 4);
      assert.equal(result.frontmatter.title, '維摩詰所說經');
      assert.equal(result.frontmatter.author, '鳩摩羅什');
      assert.equal(result.body, '內文');
    });
  });

  describe('2. 端對端整合驗證 (/api/search vs /api/render 行號精準對齊)', () => {
    let tmpDir;
    const testFileRel = 'test-frontmatter-doc.md';

    test('端對端斷言：搜尋回報行號與渲染 data-line 錨點精確對齊無 frontmatter 偏移', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-fm-test-'));
      const testFileAbs = path.join(tmpDir, testFileRel);

      // 建立含 9 行 frontmatter 的檔案，目標文字在原始檔第 40 行
      let content = [
        '---',
        'title: 測試經文',
        '講者: 玅境長老',
        '經名: 維摩詰經',
        '品次: 佛國品第一',
        '類型: 筆錄',
        '年份: 1993',
        '地點: 美國法雲寺',
        '---',
        ''
      ].join('\n');

      let curLines = content.split('\n').length - 1;
      for (let i = curLines + 1; i < 40; i++) {
        content += `這是第${i}行前置經文段落。\n`;
      }
      content += '怎麼樣學習佛法呢就是聞思修這三個方法\n';
      fs.writeFileSync(testFileAbs, content, 'utf-8');

      // 1. 搜尋引擎行號計算（mirror /api/search 及 scanText 行號邏輯）
      const { scanText } = require('../lib/text.js');
      const searchMatches = scanText(content, ['聞思修這三個方法'], 40, true);
      assert.ok(searchMatches.length > 0, '搜尋應命中');
      const searchLine = searchMatches[0].line;
      assert.equal(searchLine, 40, '搜尋回報的行號必須為原始檔第 40 行');

      // 2. 渲染路徑：修正前 lineOffset=0，產生的 data-line 偏離 9 行 (40 - 9 = 31)
      const { stripFrontmatter } = require('../lib/markdown.js');
      const { renderWithWorker } = require('../lib/worker-pool.js');
      const { body, lineOffset } = stripFrontmatter(content);
      assert.equal(lineOffset, 9, '9 行 frontmatter 應計算出 lineOffset = 9');

      // 驗證修正後渲染出的 HTML 錨點等於原始行號 40
      const htmlFixed = await renderWithWorker(body, testFileRel, lineOffset);
      const matchFixed = htmlFixed.match(/data-line="(\d+)"[^>]*><\/span>([^<]*聞思修這三個方法[^<]*)/);
      assert.ok(matchFixed, '渲染出的 HTML 應包含段落錨點');
      const renderedLineFixed = parseInt(matchFixed[1], 10);
      assert.equal(renderedLineFixed, searchLine, `渲染出的 data-line (${renderedLineFixed}) 必須等於搜尋原始行號 (${searchLine})`);

      // 驗證修正前行為 (lineOffset = 0 時相差 9 行重現)
      const htmlBuggy = await renderWithWorker(body, testFileRel, 0);
      const matchBuggy = htmlBuggy.match(/data-line="(\d+)"[^>]*><\/span>([^<]*聞思修這三個方法[^<]*)/);
      assert.ok(matchBuggy);
      const renderedLineBuggy = parseInt(matchBuggy[1], 10);
      assert.equal(renderedLineBuggy, 31, '修正前 lineOffset=0 應產生 31 行錨點');
      assert.equal(searchLine - renderedLineBuggy, 9, '修正前兩者相差正好為 9 行 frontmatter');

      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
