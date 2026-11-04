/**
 * @file tests/test-fonts-selfhosted.test.js
 *
 * 自架字型（alpha 批次 1）：
 *   1. index.html 不再向 Google Fonts 取字（那是全站唯一的外部請求，與 README
 *      「不依賴外部服務」的承諾矛盾，離線時字型也會掉回系統字）。
 *   2. 兩個 @font-face 表存在，且每一條 src 都指向真的存在的 woff2 檔。
 *   3. 每個 woff2 都帶 unicode-range（沒有就會被瀏覽器無條件下載，失去切片意義）。
 *   4. 字型的 unicode-range 覆蓋本藏經論實際用到的字（抽樣檢查常見字與罕用字）。
 *   5. sw.js 預快取兩個 @font-face 表，但**不**預快取 216 個切片（安裝會變太慢）。
 *   6. 兩個 CSS 的 ?v= 與 package.json 一致（沿用既有的版本一致性規則）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

const NOTO_CSS_PATH = path.join(ROOT_DIR, 'vendor/fonts/noto-serif-tc.css');
const INTER_CSS_PATH = path.join(ROOT_DIR, 'vendor/fonts/inter/inter.css');
const NOTO_CSS = fs.readFileSync(NOTO_CSS_PATH, 'utf8');
const INTER_CSS = fs.readFileSync(INTER_CSS_PATH, 'utf8');

/** 把 unicode-range 字串展開成碼位集合。 */
function parseRanges(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const p = part.trim().replace(/^U\+/i, '');
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-');
      const lo = parseInt(a, 16);
      const hi = parseInt(b, 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        for (let c = lo; c <= hi; c++) out.add(c);
      }
    } else {
      const c = parseInt(p, 16);
      if (Number.isFinite(c)) out.add(c);
    }
  }
  return out;
}

/** 取出一個 CSS 裡所有 @font-face 的 { weight, src, ranges }。 */
function parseFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1];
    const src = (body.match(/url\(([^)]+)\)/) || [])[1];
    const ranges = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    faces.push({ weight, src, ranges });
  }
  return faces;
}

describe('自架字型：不再依賴 Google Fonts', () => {
  test('index.html 不含任何 fonts.googleapis / fonts.gstatic 連結', () => {
    assert.ok(
      !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(INDEX_HTML),
      'index.html 不應再引用 Google Fonts（外部請求）'
    );
  });

  test('index.html 以相對路徑載入兩個自架 @font-face 表，且帶版本參數', () => {
    for (const href of ['vendor/fonts/inter/inter.css', 'vendor/fonts/noto-serif-tc.css']) {
      const re = new RegExp(
        `href="${href.replace(/\./g, '\\.')}\\?v=${PKG.version.replace(/\./g, '\\.')}"`
      );
      assert.match(INDEX_HTML, re, `index.html 應以 ?v=${PKG.version} 載入 ${href}`);
    }
  });

  test('不再有 preconnect 到 Google 字型網域', () => {
    assert.ok(!/rel="preconnect"[^>]*fonts\.g/.test(INDEX_HTML));
  });
});

describe('自架字型：@font-face 表結構', () => {
  test('Noto Serif TC 有 400 與 700 兩個字重，且條數一致', () => {
    const faces = parseFaces(NOTO_CSS);
    const w400 = faces.filter((f) => f.weight === '400');
    const w700 = faces.filter((f) => f.weight === '700');
    assert.ok(w400.length > 0, '應有 400 字重');
    assert.ok(w700.length > 0, '應有 700 字重');
    assert.equal(
      w400.length,
      w700.length,
      '兩個字重的切片數應一致，否則某個字重會缺字'
    );
  });

  test('Inter 有 400 / 600 / 700 三個字重', () => {
    const weights = new Set(parseFaces(INTER_CSS).map((f) => f.weight));
    for (const w of ['400', '600', '700']) {
      assert.ok(weights.has(w), `Inter 應有 ${w} 字重（style.css 用到 700 粗體）`);
    }
  });

  test('每一條 @font-face 都有 unicode-range（否則會被無條件下載）', () => {
    for (const [name, css] of [['Noto Serif TC', NOTO_CSS], ['Inter', INTER_CSS]]) {
      const missing = parseFaces(css).filter((f) => !f.ranges);
      assert.equal(missing.length, 0, `${name} 有 ${missing.length} 條缺少 unicode-range`);
    }
  });

  test('每一條 src 指向的 woff2 都真的存在', () => {
    for (const [cssPath, css] of [
      [NOTO_CSS_PATH, NOTO_CSS],
      [INTER_CSS_PATH, INTER_CSS]
    ]) {
      const dir = path.dirname(cssPath);
      const missing = [];
      for (const f of parseFaces(css)) {
        if (!f.src) continue;
        const abs = path.resolve(dir, f.src.replace(/^\.\//, ''));
        if (!fs.existsSync(abs)) missing.push(f.src);
      }
      assert.equal(
        missing.length,
        0,
        `${path.basename(cssPath)} 有 ${missing.length} 個 src 指向不存在的檔案：${missing.slice(0, 5).join(', ')}`
      );
    }
  });

  test('切片總數與檔案數相符（沒有孤兒 woff2 被漏掉）', () => {
    const faces = parseFaces(NOTO_CSS);
    const onDisk = ['w400', 'w700'].flatMap((w) => {
      const d = path.join(ROOT_DIR, 'vendor/fonts/noto-serif-tc', w);
      return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.woff2')) : [];
    });
    assert.equal(
      onDisk.length,
      faces.length,
      `磁碟上有 ${onDisk.length} 個切片，CSS 只宣告了 ${faces.length} 條`
    );
  });
});

describe('自架字型：涵蓋本藏用字', () => {
  const covered = (() => {
    const s = new Set();
    for (const f of parseFaces(NOTO_CSS)) if (f.ranges) for (const c of parseRanges(f.ranges)) s.add(c);
    return s;
  })();

  test('常見經文用字都在涵蓋範圍內', () => {
    const sample = '佛般若波羅蜜多心經觀自在菩薩行深時照見五蘊皆空度一切苦厄舍利子色不異空空不異色受想行識亦復如是';
    const missing = [...sample].filter((ch) => !covered.has(ch.codePointAt(0)));
    assert.equal(missing.length, 0, `缺少常見字：${missing.join('')}`);
  });

  test('《金剛經》全文字形覆蓋率 100%', () => {
    const sutraPath = path.join(ROOT_DIR, 'md/01-大正藏/03般若部類/T0235《金剛般若波羅蜜經》.md');
    if (!fs.existsSync(sutraPath)) return; // 語料未掛載時略過（CI 只有程式碼）
    const text = fs.readFileSync(sutraPath, 'utf8');
    const missing = new Set();
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp > 0x7f && !covered.has(cp)) missing.add(ch);
    }
    assert.equal(
      missing.size,
      0,
      `《金剛經》有 ${missing.size} 個字不在字型涵蓋範圍：${[...missing].slice(0, 10).join('')}`
    );
  });

  test('orphan 切片：Google 原始 unicode-range 沒涵蓋的罕用字也有字型', () => {
    // 這幾個字在 Google 的分段裡是缺的，靠 orphan 切片補上。
    // 少了它們，《瑜伽師地論》與密教部會出現豆腐方塊。
    for (const ch of '䭾叅跢悞') {
      assert.ok(
        covered.has(ch.codePointAt(0)),
        `罕用字 ${ch}（U+${ch.codePointAt(0).toString(16).toUpperCase()}）應被涵蓋`
      );
    }
  });
});

describe('自架字型：Service Worker 快取策略', () => {
  test('sw.js 預快取兩個 @font-face 表', () => {
    for (const p of ['/vendor/fonts/inter/inter.css', '/vendor/fonts/noto-serif-tc.css']) {
      assert.ok(SW_JS.includes(`'${p}'`), `sw.js 的 SHELL_ASSETS 應包含 ${p}`);
    }
  });

  test('sw.js 不預快取個別 woff2 切片（216 個約 6 MB，會拖慢安裝）', () => {
    assert.ok(
      !/SHELL_ASSETS[\s\S]{0,4000}\.woff2'[^,]*vendor\/fonts\/noto-serif-tc/.test(SW_JS),
      'SHELL_ASSETS 不應列出 noto-serif-tc 的個別切片'
    );
  });
});
