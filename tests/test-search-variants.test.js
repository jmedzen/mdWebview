/**
 * 搜尋字組（簡繁變體類別）：i18n/search-variants.js、lib/text.js 字組掃描、
 * server.js 的索引候選與 /api/search、/api/search-file、/api/dict-search 端對端行為。
 *
 * 取代 v3.10.x 的 tests/test-s2t.test.js（s2t.js 已移除）。原本「简体字轉成哪個繁體字」
 * 的回歸案例改寫為「兩者屬於同一字組、互相命中」。
 *
 * 伺服器測試以臨時 vault／辭典／logs／config 執行，與專案的 config.json 無關。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ── 伺服器測試用的臨時 vault／辭典／logs／config ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-variants-'));
const tmpVault = path.join(tmpRoot, 'vault');
const tmpDicts = path.join(tmpRoot, 'dicts');
const tmpLogs = path.join(tmpRoot, 'logs');
const tmpConfig = path.join(tmpRoot, 'config.json');
fs.mkdirSync(tmpVault, { recursive: true });
fs.mkdirSync(tmpDicts, { recursive: true });
fs.mkdirSync(tmpLogs, { recursive: true });
fs.writeFileSync(path.join(tmpVault, 'trad.md'), [
  '# 繁體經文', '', '然後如是。皇后在此。', '', '頭髮長，發心修行。', '', '著衣持鉢，他着衣。', ''
].join('\n'));
fs.writeFileSync(path.join(tmpVault, 'simp.md'), [
  '# 简体文件', '', '后来这个人无为而治。', ''
].join('\n'));
fs.writeFileSync(path.join(tmpDicts, '測試辭典.md'), [
  '# 測試辭典', '', '## 頭髮', '', '頭上之毛，亦稱髮。', '', '## 後來', '', '其後之時。', ''
].join('\n'));
fs.writeFileSync(tmpConfig, JSON.stringify({
  settings: { mdRoot: tmpVault, dictionaryEnabled: true, dictionaryPath: tmpDicts }
}), 'utf-8');

// 必須在載入任何 lib/ 模組（lib/auth.js 會載入 lib/config.js）之前設定：
// 設定在模組載入時即合併，CONFIG_PATH 最後套用，因此可蓋過專案的 config.json。
process.env.LOG_DIR = tmpLogs;
process.env.CONFIG_PATH = tmpConfig;
process.env.MD_ROOT = tmpVault;
process.env.DICTIONARY_PATH = tmpDicts;

const ROOT = path.join(__dirname, '..');
const sv = require('../i18n/search-variants.js');
const { buildVariantData, renderBlock, readCurrentBlock, EXTRA_VARIANTS, TARGET } = require('../tools/build-search-variants.js');
const OpenCC = require('../vendor/opencc/t2cn.js');
const { scanText, findTermPositions } = require('../lib/text.js');
const { apiRateLimits } = require('../lib/auth.js');

const tw2cn = OpenCC.Converter({ from: 'tw', to: 'cn' });
const inRange = (c) => {
  const x = c.charCodeAt(0);
  return c.length === 1 && ((x >= 0x3400 && x <= 0x4DBF) || (x >= 0x4E00 && x <= 0x9FFF));
};

describe('字組 1：產生的資料與 vendored OpenCC 同步', () => {
  test('i18n/search-variants.js 的資料區塊等於重新產生的結果', () => {
    const data = buildVariantData();
    assert.equal(sv.CLASSES, data.classes, 'CLASSES 不同步：請執行 node tools/build-search-variants.js');
    assert.equal(sv.SIMPLIFIED, data.simplified, 'SIMPLIFIED 不同步');
    const cur = readCurrentBlock(fs.readFileSync(TARGET, 'utf8'));
    assert.equal(cur.text, renderBlock(data));
  });

  test('簡體顯示的每個轉換結果都與原字同組（畫面所見即可搜尋）', () => {
    let checked = 0;
    for (let cp = 0x3400; cp <= 0x9FFF; cp++) {
      if (cp > 0x4DBF && cp < 0x4E00) continue;
      const t = String.fromCharCode(cp);
      const s = tw2cn(t);
      if (s === t || !inRange(s)) continue;
      assert.ok(sv.same(t, s), `${t} → ${s} 應屬同一字組`);
      assert.ok(sv.hasSimplified(s), `${s} 應判定為簡體字形`);
      checked++;
    }
    assert.ok(checked > 2500, `應涵蓋數千組轉換（實際 ${checked}）`);
  });

  test('字組彼此不重疊、皆在索引的 CJK 區段內、至少兩字且不過大', () => {
    const seen = new Set();
    for (const cls of sv.CLASSES.split('|')) {
      assert.ok(cls.length >= 2, `字組「${cls}」少於兩字`);
      assert.ok(cls.length <= 8, `字組「${cls}」過大`);
      for (const ch of cls) {
        assert.ok(inRange(ch), `${ch} 不在 bigram 索引的 CJK 區段`);
        assert.ok(!seen.has(ch), `${ch} 出現在多個字組`);
        seen.add(ch);
      }
    }
  });

  test('EXTRA_VARIANTS（OpenCC 不會輸出的簡繁對應）已併入', () => {
    for (const [s, t] of EXTRA_VARIANTS) assert.ok(sv.same(s, t), `${s}／${t}`);
    assert.ok(sv.same('缐', '線') && sv.same('缐', '线'));
    assert.ok(sv.same('锺', '鍾') && sv.same('锺', '钟'));
  });
});

describe('字組 2：字形對應（原 s2t 回歸案例）', () => {
  test('使用者回報的案例：后／後、发／發／髮、着／著', () => {
    assert.equal([...sv.variantsOf('后')].sort().join(''), [...'后後'].sort().join(''));
    assert.ok(sv.same('发', '發') && sv.same('发', '髮') && sv.same('發', '髮'));
    assert.ok(sv.same('着', '著'));
  });

  test('常見經文用字互相命中', () => {
    const pairs = ['观觀', '萨薩', '经經', '罗羅', '无無', '头頭', '这這', '来來', '说說', '为為', '为爲', '众眾',
      '伪偽', '启啟', '钵鉢', '违違', '觎覦', '干乾', '干幹'];
    for (const p of pairs) assert.ok(sv.same(p[0], p[1]), `${p[0]}／${p[1]}`);
  });

  test('曾經的誤植不得出現：违≠維、觎≠覬', () => {
    assert.equal(sv.same('违', '維'), false);
    assert.equal(sv.same('觎', '覬'), false);
    assert.equal(sv.same('后', '候'), false);
  });

  test('fold 換成代表字且長度不變；非 CJK 原樣保留', () => {
    const s = 'Hello, 頭髮與头发！12345 — 《金剛經》';
    const f = sv.fold(s);
    assert.equal(f.length, s.length);
    assert.equal(sv.fold('頭髮'), sv.fold('头发'));
    assert.equal(sv.fold('abc 123'), 'abc 123');
    assert.equal(sv.fold(''), '');
    assert.equal(sv.fold(null), '');
  });

  test('hasSimplified／hasVariants', () => {
    assert.equal(sv.hasSimplified('般若波罗蜜多'), true);
    assert.equal(sv.hasSimplified('觀自在菩薩'), false);
    assert.equal(sv.hasSimplified('English text 12345'), false);
    assert.equal(sv.hasSimplified(''), false);
    assert.equal(sv.hasSimplified(null), false);
    assert.equal(sv.hasVariants('觀'), true);
    assert.equal(sv.hasVariants('abc'), false);
  });

  test('termPattern：嚴格／寬鬆樣式、正規表達式特殊字元跳脫', () => {
    const strict = new RegExp(sv.termPattern('后来', false), 'gu');
    assert.deepEqual('後來 后来 後来'.match(strict), ['後來', '后来', '後来']);
    const loose = new RegExp(sv.termPattern('后，来', true), 'gu');
    assert.deepEqual('然後，\n來了'.match(loose), ['後，\n來']);
    const special = new RegExp(sv.termPattern('a.b(c)-[d]|/', false), 'gu');
    assert.ok(special.test('xa.b(c)-[d]|/y'));
    assert.equal(new RegExp(sv.termPattern('a.b', false), 'gu').test('axb'), false);
  });

  test('透明字元集與 lib/text.js TRANSPARENT_RE 相同', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'text.js'), 'utf8');
    const m = src.match(/const TRANSPARENT_RE = \/(.+)\/u;/);
    assert.ok(m);
    assert.equal(sv.TRANSPARENT_SOURCE, m[1]);
  });

  test('expandBigram：列出字組組合，超過上限回傳 null', () => {
    const combos = sv.expandBigram('头发');
    assert.equal(combos.length, 2 * 3);
    assert.ok(combos.includes('頭髮') && combos.includes('頭發') && combos.includes('头发'));
    assert.equal(sv.expandBigram('头发', 4), null);
    assert.deepEqual(sv.expandBigram('ab'), ['ab']);
  });
});

describe('字組 3：lib/text.js 掃描', () => {
  const text = [
    '然後如是。皇后在此。',   // 1
    '頭髮長，發心修行。',     // 2
    '著衣持鉢，他着衣。',     // 3
    '后来这个人无为而治。'    // 4 簡體來源
  ].join('\n');

  test('后 同時命中 後 與 后（嚴格／寬鬆）', () => {
    for (const loose of [false, true]) {
      const lines = scanText(text, ['后'], 150, loose, true).map(m => m.line);
      assert.deepEqual(lines, [1, 1, 4], `loose=${loose}`);
    }
    assert.deepEqual(scanText(text, ['后'], 150, false, false).map(m => m.line), [1, 4], '未開啟字組時只命中字面');
  });

  test('发 命中 發 與 髮；着 命中 着 與 著', () => {
    assert.equal(scanText(text, ['发'], 150, false, true).length, 2);
    assert.equal(scanText(text, ['着衣'], 150, false, true).length, 2);
    assert.equal(scanText(text, ['著衣'], 150, true, true).length, 2);
  });

  test('簡體來源的文字可用繁體查詢找到，反之亦然', () => {
    assert.deepEqual(scanText(text, ['後來'], 150, false, true).map(m => m.line), [4]);
    assert.deepEqual(scanText(text, ['無為'], 150, true, true).map(m => m.line), [4]);
    assert.deepEqual(scanText(text, ['头发'], 150, false, true).map(m => m.line), [2]);
  });

  test('寬鬆模式略過標點；位置與摘要取自原文', () => {
    const pos = findTermPositions('然後，來了', '后来', true, true, []);
    assert.deepEqual(pos, [1, 4]);
    const [m] = scanText(text, ['头髮长'], 150, true, true);
    assert.equal(m.line, 2);
    assert.match(m.snippet, /頭髮長/, '摘要保留原文字形');
  });

  test('多詞鄰近過濾同樣以字組比對', () => {
    const ms = scanText(text, ['皇后', '如是'], 150, false, true);
    assert.equal(ms.length, 1);
    assert.equal(scanText(text, ['头发', '无为'], 5, false, true).length, 0, '超過鄰近距離不命中');
  });

  test('未開啟字組比對時與字面掃描完全相同', () => {
    for (const q of [['如是'], ['后'], ['頭髮', '發心'], ['著衣。']]) {
      for (const loose of [false, true]) {
        assert.deepEqual(scanText(text, q, 150, loose, false), scanText(text, q, 150, loose));
      }
    }
  });
});

describe('字組 4：伺服器 API（臨時 vault 與辭典）', () => {
  let srv;
  let baseUrl = '';

  function getJson(pathname, params) {
    apiRateLimits.clear(); // 本測試短時間內大量請求，避開每秒 30 次的 API 限流
    const url = new URL(pathname, baseUrl);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    return new Promise((resolve, reject) => {
      const req = http.request(url, { agent: false, headers: { Connection: 'close' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`${res.statusCode} ${body}`)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  const files = (data) => Array.from(new Set(data.results.map(r => r.file))).sort();

  before(async () => {
    srv = require('../server.js');
    await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
  });

  after(async () => {
    srv.resetTreeWatcher();
    srv.resetDictWatcher();
    srv.resetConfigWatcher();
    await srv.terminateWorkerPools();
    if (typeof srv.server.closeAllConnections === 'function') srv.server.closeAllConnections();
    await new Promise((resolve) => srv.server.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('isVariantSearch：variants 優先，未帶時沿用 s2t（皆未帶預設開啟）', () => {
    assert.equal(srv.isVariantSearch({ variants: '1' }), true);
    assert.equal(srv.isVariantSearch({ variants: '0', s2t: '1' }), false);
    assert.equal(srv.isVariantSearch({ s2t: '0' }), false);
    assert.equal(srv.isVariantSearch({ s2t: 'true' }), true);
    assert.equal(srv.isVariantSearch({}), true);
  });

  test('indexCandidates：字組組合取聯集；組合數超過上限時該 bigram 不參與縮小範圍', () => {
    const bigrams = new Map([['頭髮', 1], ['頭發', new Uint32Array([2, 5])], ['头发', 3], ['無為', 4], ['如是', 4]]);
    const len = (t) => t.length;
    assert.deepEqual(srv.indexCandidates(bigrams, ['头发'], false, len), [3]);
    assert.deepEqual(srv.indexCandidates(bigrams, ['头发'], true, len), [1, 2, 3, 5]);
    assert.deepEqual(srv.indexCandidates(bigrams, ['頭髮'], true, len), [1, 2, 3, 5]);
    assert.deepEqual(srv.indexCandidates(bigrams, ['后来'], true, len), []);
    // 六字組 × 六字組 = 36 組合，仍在上限內
    assert.ok(sv.expandBigram('钟钟').length <= sv.DEFAULT_BIGRAM_CAP);
    const origCap = sv.DEFAULT_BIGRAM_CAP;
    try {
      sv.DEFAULT_BIGRAM_CAP = 4;
      // 2 × 3 = 6 > 4：此 bigram 不可用，整個詞無法縮小範圍 → null（改為掃描）
      assert.equal(srv.indexCandidates(bigrams, ['头发'], true, len), null);
      // 另一個 bigram 仍可縮小範圍
      assert.deepEqual(srv.indexCandidates(bigrams, ['头发', '如是'], true, len), [4]);
    } finally {
      sv.DEFAULT_BIGRAM_CAP = origCap;
    }
  });

  async function searchBoth(mode) {
    const out = {};
    for (const [label, q, variants] of [
      ['后', '后', '1'], ['后-exact', '后', '0'], ['后来', '后来', '1'], ['后来-exact', '后来', '0'],
      ['头发', '头发', '1'], ['着衣', '着衣', '1'], ['着衣-exact', '着衣', '0'], ['無為', '無為', '1'], ['無為-exact', '無為', '0']
    ]) {
      out[label] = await getJson('/api/search', { q, variants, mode });
    }
    return out;
  }

  function assertSearchResults(r, mode) {
    assert.deepEqual(files(r['后']), ['simp.md', 'trad.md'], `${mode}: 后 命中繁體與簡體來源`);
    assert.equal(r['后'].results.filter(x => x.file === 'trad.md').length, 2, `${mode}: 後、后 各一`);
    assert.equal(r['后'].variants, true);
    assert.equal(r['后'].query, '后', '回應保留使用者原文');
    assert.deepEqual(files(r['后-exact']), ['simp.md', 'trad.md'], `${mode}: 字面 后 也在 trad.md（皇后）`);
    assert.equal(r['后-exact'].results.filter(x => x.file === 'trad.md').length, 1);
    assert.equal(r['后-exact'].variants, false);
    assert.deepEqual(files(r['后来']), ['simp.md'], `${mode}: 简体来源檔案可被找到`);
    assert.deepEqual(files(r['后来-exact']), ['simp.md']);
    assert.deepEqual(files(r['头发']), ['trad.md']);
    assert.equal(r['着衣'].results.length, 2, `${mode}: 着衣 命中 著衣 與 着衣`);
    assert.equal(r['着衣-exact'].results.length, 1);
    assert.deepEqual(files(r['無為']), ['simp.md'], `${mode}: 繁體查詢命中簡體來源`);
    assert.equal(r['無為-exact'].results.length, 0);
  }

  test('/api/search（索引尚未建立：全檔掃描）', async () => {
    for (const mode of ['strict', 'loose']) assertSearchResults(await searchBoth(mode), mode);
  });

  test('/api/search（Bigram 索引就緒：字組組合查索引）', async () => {
    srv.resetTreeWatcher(); // 清除結果快取並重設索引，再同步建好索引
    await srv.buildSearchIndexAsync(true);
    for (const mode of ['strict', 'loose']) assertSearchResults(await searchBoth(mode), mode + '+index');
  });

  test('快取鍵包含字組模式：同一查詢切換 variants 不會拿到對方的結果', async () => {
    const a = await getJson('/api/search', { q: '着衣', variants: '1', mode: 'strict', folder: 'trad.md' });
    const b = await getJson('/api/search', { q: '着衣', variants: '0', mode: 'strict', folder: 'trad.md' });
    const c = await getJson('/api/search', { q: '着衣', variants: '1', mode: 'strict', folder: 'trad.md' });
    assert.equal(a.results.length, 2);
    assert.equal(b.results.length, 1);
    assert.equal(c.results.length, 2);
  });

  test('舊的 s2t 參數仍有效（s2t=1 等同字組比對，s2t=0 為字面）', async () => {
    const on = await getJson('/api/search', { q: '头发', s2t: '1', mode: 'loose', folder: 'trad.md' });
    const off = await getJson('/api/search', { q: '头发', s2t: '0', mode: 'loose', folder: 'trad.md' });
    assert.equal(on.results.length, 1);
    assert.equal(off.results.length, 0);
    assert.equal(off.query, '头发');
  });

  test('檔名搜尋也以字組比對', async () => {
    const r = await getJson('/api/search', { q: '简体', variants: '1', folder: '__FILENAME_ONLY__' });
    assert.equal(r.results.length, 0, '檔名 simp／trad 不含中文');
    const r2 = await getJson('/api/search', { q: 'SIMP', variants: '1', folder: '__FILENAME_ONLY__' });
    assert.deepEqual(files(r2), ['simp.md']);
  });

  test('/api/search-file 以字組比對單檔', async () => {
    const on = await getJson('/api/search-file', { path: 'trad.md', q: '后', variants: '1' });
    const off = await getJson('/api/search-file', { path: 'trad.md', q: '后', variants: '0' });
    assert.deepEqual(on.matches.map(m => m.line), [3, 3]);
    assert.deepEqual(off.matches.map(m => m.line), [3]);
    assert.equal(on.variants, true);
  });

  test('/api/dict-search 以字組比對（索引前後一致）', async () => {
    const check = async (label) => {
      const on = await getJson('/api/dict-search', { q: '头发', variants: '1' });
      const off = await getJson('/api/dict-search', { q: '头发', variants: '0' });
      assert.ok(on.results.length >= 1, `${label}: 头发 應命中 頭髮`);
      assert.ok(on.results.every(r => r.file === 'dict:測試辭典.md'));
      assert.equal(on.variants, true);
      assert.equal(off.results.length, 0, `${label}: 字面查詢不命中`);
      const later = await getJson('/api/dict-search', { q: '后来', variants: '1' });
      assert.ok(later.results.some(r => /後來/.test(r.snippet)), `${label}: 后来 命中 後來`);
    };
    await check('scan');
    await srv.buildDictIndexAsync(true);
    await check('index');
  });
});
