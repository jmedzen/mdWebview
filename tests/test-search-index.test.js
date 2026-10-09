const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const s2t = require('../s2t.js');

// Load scanSections from index-worker.js; extractBigramsFromText from lib/text.js
const { extractBigramsFromText } = require('../lib/text.js');
const extractBigrams = extractBigramsFromText;
const workerFile = fs.readFileSync(path.join(__dirname, '../index-worker.js'), 'utf8');
const scanSectionsMatch = workerFile.match(/function scanSections\(text\) \{[\s\S]*?\n\}/);

const scanSections = new Function('text', `const HEADING_RE = /^(#{1,6})\\s+(.*)$/;\n${scanSectionsMatch[0]}; return scanSections(text);`);

// Inverted index intersection function from server.js
function intersectSorted(a, b) {
  let i = 0, j = 0;
  const la = a.length, lb = b.length;
  const result = [];
  while (i < la && j < lb) {
    const va = a[i], vb = b[j];
    if (va === vb) { result.push(va); i++; j++; }
    else if (va < vb) { i++; }
    else { j++; }
  }
  return result;
}

describe('全文搜尋與 Bigram 倒排索引演算法測試', () => {
  test('CJK Bigram 2-gram 提取與標點隔離', () => {
    const text = '觀自在菩薩，行深般若波羅蜜多';
    const bigrams = Array.from(extractBigrams(text));

    // 「觀自」「自在」「在菩」「菩薩」
    assert.ok(bigrams.includes('觀自'));
    assert.ok(bigrams.includes('自在'));
    assert.ok(bigrams.includes('在菩'));
    assert.ok(bigrams.includes('菩薩'));

    // 標點符號透明：「薩，行」應產生 Bigram「薩行」，但不應包含標點本身
    assert.ok(bigrams.includes('薩行'));
    assert.ok(!bigrams.includes('薩，'));
    assert.ok(!bigrams.includes('，行'));

    // 標點與換行透明，但空白斷詞：跨換行產生「薩行」，但跨空白不應產生「薩行」
    const newlineText = '菩薩\n行深';
    const newlineBigrams = Array.from(extractBigrams(newlineText));
    assert.ok(newlineBigrams.includes('薩行'), '換行透明應產生「薩行」');

    const spaceText = '菩薩 行深';
    const spaceBigrams = Array.from(extractBigrams(spaceText));
    assert.ok(!spaceBigrams.includes('薩行'), '空白視為詞分隔，不應產生跨空白 Bigram「薩行」');

    // 「行深」「深般」「般若」「若波」「波羅」「羅蜜」「蜜多」
    assert.ok(bigrams.includes('般若'));
    assert.ok(bigrams.includes('波羅'));
    assert.ok(bigrams.includes('蜜多'));
  });

  test('排序倒排清單交集計算 (intersectSorted)', () => {
    const listA = [1, 5, 8, 12, 19, 25, 40];
    const listB = [2, 5, 12, 20, 25, 30, 40];
    const intersected = intersectSorted(listA, listB);
    assert.deepEqual(intersected, [5, 12, 25, 40]);

    // 無交集情況
    assert.deepEqual(intersectSorted([1, 2, 3], [4, 5, 6]), []);
    // 空清單交集
    assert.deepEqual(intersectSorted([], [1, 2, 3]), []);
  });

  test('章節分段掃描 (scanSections) 與位元組位移', () => {
    const content = [
      '# 第一卷 本地分',
      '這是前言內容。',
      '## 第一節 五識相應地',
      '這是五識內容。',
      '## 第二節 意地',
      '這是意地內容。'
    ].join('\n');

    const result = scanSections(content);
    // 深層標題 (##) 作為 entries，較淺層標題 (#) 作為 groups 類別分組
    assert.equal(result.entries.length, 2);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].headword, '第一卷 本地分');
    assert.equal(result.entries[0].headword, '第一節 五識相應地');
    assert.equal(result.entries[1].headword, '第二節 意地');
    assert.ok(result.totalBytes > 0);
    assert.equal(result.totalLines, 6);
  });

  test('搜尋 S2T 參數控制 (s2t=0 保留簡體 vs s2t=1 強制繁體)', () => {
    function resolveQuery(query) {
      const rawQ = (query.q || '').trim();
      const shouldS2T = query.s2t !== undefined ? (query.s2t === '1' || query.s2t === 'true') : true;
      return shouldS2T ? s2t.toTraditional(rawQ) : rawQ;
    }

    // 1. 預設（未傳入 s2t 參數）-> 預設轉換為繁體以向後相容
    assert.equal(resolveQuery({ q: '观自在菩萨' }), '觀自在菩薩');

    // 2. 顯式 s2t='1' -> 轉換為繁體
    assert.equal(resolveQuery({ q: '般若波罗蜜多', s2t: '1' }), '般若波羅蜜多');

    // 3. 顯式 s2t='0' -> 忠實保留使用者輸入的簡體
    assert.equal(resolveQuery({ q: '观自在菩萨', s2t: '0' }), '观自在菩萨');
    assert.equal(resolveQuery({ q: '般若波罗蜜多', s2t: '0' }), '般若波罗蜜多');
  });
});
