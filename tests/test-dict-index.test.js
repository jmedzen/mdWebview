const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Model frontend dictionary search engine in app.js
function buildDictIndex(rawEntries) {
  // rawEntries: [[fi, ei, line, hw], ...]
  const sorted = rawEntries.map(r => ({ hw: r[3], fi: r[0], ei: r[1], line: r[2] }));
  sorted.sort((a, b) => (a.hw < b.hw ? -1 : a.hw > b.hw ? 1 : (a.fi - b.fi || a.ei - b.ei)));

  // Build bigram index for fuzzy search
  const bigrams = new Map();
  sorted.forEach((it, idx) => {
    for (let i = 0; i < it.hw.length - 1; i++) {
      const bg = it.hw.substring(i, i + 2);
      let arr = bigrams.get(bg);
      if (!arr) { arr = []; bigrams.set(bg, arr); }
      arr.push(idx);
    }
  });

  return { sorted, bigrams };
}

function searchPrefix(idx, q, selectedFiles = new Set([0, 1])) {
  const sorted = idx.sorted;
  if (!sorted || sorted.length === 0 || !q) return [];

  // Binary search for range [q, q + '\uffff')
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].hw < q) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;

  const upper = q + '\uffff';
  lo = start; hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].hw < upper) lo = mid + 1;
    else hi = mid;
  }
  const end = lo;

  const matched = [];
  for (let i = start; i < end; i++) {
    const it = sorted[i];
    if (it.hw.startsWith(q) && selectedFiles.has(it.fi)) {
      matched.push(it);
    }
  }
  return matched;
}

describe('佛學辭典詞頭索引與搜尋引擎測試', () => {
  const sampleEntries = [
    [0, 1, 10, '阿賴耶識'],
    [0, 2, 25, '阿耨多羅三藐三菩提'],
    [0, 3, 40, '阿僧祇劫'],
    [1, 1, 15, '阿難'],
    [1, 2, 30, '般若'],
    [1, 3, 50, '般若波羅蜜多'],
    [1, 4, 70, '菩提']
  ];

  const dictIdx = buildDictIndex(sampleEntries);

  test('詞頭依 Unicode 碼位正確排序', () => {
    const headwords = dictIdx.sorted.map(s => s.hw);
    for (let i = 0; i < headwords.length - 1; i++) {
      assert.ok(headwords[i] <= headwords[i + 1], `詞頭應有序: ${headwords[i]} <= ${headwords[i + 1]}`);
    }
  });

  test('二分搜尋精確前綴命中 (以「阿」開頭)', () => {
    const matches = searchPrefix(dictIdx, '阿');
    const matchedHws = matches.map(m => m.hw);
    assert.equal(matches.length, 4);
    assert.ok(matchedHws.includes('阿賴耶識'));
    assert.ok(matchedHws.includes('阿耨多羅三藐三菩提'));
    assert.ok(matchedHws.includes('阿僧祇劫'));
    assert.ok(matchedHws.includes('阿難'));
    assert.ok(!matchedHws.includes('般若'));
  });

  test('二分搜尋多字精確前綴命中 (以「般若」開頭)', () => {
    const matches = searchPrefix(dictIdx, '般若');
    assert.equal(matches.length, 2);
    assert.equal(matches[0].hw, '般若');
    assert.equal(matches[1].hw, '般若波羅蜜多');
  });

  test('詞頭前綴二分搜尋邊界安全性 (使用 \\uffff 避免越界或遺漏)', () => {
    const matches = searchPrefix(dictIdx, '菩提');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].hw, '菩提');

    // 查無此前綴
    const notFound = searchPrefix(dictIdx, '涅槃');
    assert.equal(notFound.length, 0);
  });

  test('辭典檔案篩選 (selectedFiles)', () => {
    // 僅選取字典 0
    const matchesFile0 = searchPrefix(dictIdx, '阿', new Set([0]));
    assert.equal(matchesFile0.length, 3);
    assert.ok(!matchesFile0.some(m => m.hw === '阿難')); // 阿難在字典 1

    // 僅選取字典 1
    const matchesFile1 = searchPrefix(dictIdx, '阿', new Set([1]));
    assert.equal(matchesFile1.length, 1);
    assert.equal(matchesFile1[0].hw, '阿難');
  });
});
