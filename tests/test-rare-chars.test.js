'use strict';
/**
 * 罕見字：後備字型 mdRare（vendor/fonts/rare/）與朗讀的罕見字讀音表（lib/tts-lexicon-rare.txt）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RARE_DIR = path.join(ROOT, 'vendor', 'fonts', 'rare');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function parseFaces(css) {
  const faces = [];
  const re = /@font-face\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const src = /url\('([^']+)'\)/.exec(body)[1];
    const family = /font-family:'([^']+)'/.exec(body)[1];
    const ranges = /unicode-range:([^}]*)$/.exec(body)[1].split(',').map((r) => {
      const [a, b] = r.trim().slice(2).split('-');
      return [parseInt(a, 16), parseInt(b || a, 16)];
    });
    faces.push({ src, family, ranges });
  }
  return faces;
}

test('rare-font.css：每一塊都存在、字型名稱是 mdRare', () => {
  const faces = parseFaces(fs.readFileSync(path.join(RARE_DIR, 'rare-font.css'), 'utf8'));
  assert.ok(faces.length >= 10, `塊數 ${faces.length}`);
  for (const f of faces) {
    assert.strictEqual(f.family, 'mdRare');
    assert.match(f.src, /^rare-[\w-]+\.woff2$/);
    assert.ok(fs.existsSync(path.join(RARE_DIR, f.src)), `缺檔 ${f.src}`);
  }
  // 沒被 CSS 用到的分塊檔（重建後忘了刪的舊檔）
  const used = new Set(faces.map((f) => f.src));
  const stray = fs.readdirSync(RARE_DIR).filter((n) => /^rare-.*\.woff2$/.test(n) && !used.has(n));
  assert.deepStrictEqual(stray, []);
});

test('rare-font.css：涵蓋 𤦲（U+249B2）、䟽、擴充 F 的字', () => {
  const faces = parseFaces(fs.readFileSync(path.join(RARE_DIR, 'rare-font.css'), 'utf8'));
  const covered = (cp) => faces.some((f) => f.ranges.some(([a, b]) => cp >= a && cp <= b));
  for (const ch of ['𤦲', '䟽', '𦦨', '𭋸']) assert.ok(covered(ch.codePointAt(0)), ch);
});

test('伺服器分享卡用的合併字型只有一個檔', () => {
  const files = fs.readdirSync(RARE_DIR).filter((n) => /^server-rare-.*\.woff2$/.test(n));
  assert.strictEqual(files.length, 1);
  assert.ok(fs.statSync(path.join(RARE_DIR, files[0])).size > 500 * 1024);
});

test('經文字型變數與分享卡都把 mdRare 排在 Noto 後面', () => {
  const css = read('style.css');
  assert.match(css, /--cjk-serif: 'Noto Serif TC', 'mdRare';/);
  assert.match(css, /--cjk-sans: 'Noto Sans TC', 'mdRare';/);
  assert.match(css, /'Noto Serif TC', 'mdRare';\n/);           // 簡體顯示
  assert.match(read('index.html'), /<link rel="stylesheet" href="vendor\/fonts\/rare\/rare-font\.css\?v=__APP_VERSION__">/);
  assert.match(read('share-card.js'), /const SERIF = '"Noto Serif TC",[^']*"mdRare"/);
});

test('oralize：charMap 把罕見字換成常用字，空字串＝略過', () => {
  const Seg = require('../tts-segment.js');
  const charMap = Object.assign(Object.create(null), { '𤦲': '璩', '䟽': '疏', '𭒂': '' });
  assert.strictEqual(Seg.oralize('車𤦲、馬瑙，華嚴經䟽，嚩日𭒂', 'sent', { lexicon: [], charMap }), '車璩、馬瑙，華嚴經疏，嚩日');
  // 字典（詞）先套，charMap 後套
  assert.strictEqual(Seg.oralize('車𤦲', 'sent', { lexicon: [['車𤦲', '硨磲']], charMap }), '硨磲');
  // 沒有 charMap 時不動
  assert.strictEqual(Seg.oralize('車𤦲', 'sent', { lexicon: [] }), '車𤦲');
});

test('內建罕見字讀音表：載入、與內建讀音表同一開關', () => {
  const lexicon = require('../lib/tts-lexicon');
  const map = lexicon.charMap(true);
  assert.ok(map);
  assert.strictEqual(map['𤦲'], '璩');
  assert.strictEqual(map['䟽'], '疏');
  assert.strictEqual(map['\u{2F835}'], '\u7070');   // 相容字 灰 → 標準字 灰
  assert.strictEqual(lexicon.charMap(false), null);
  const d = lexicon.describe();
  assert.ok(d.rare.count > 9000);
  assert.ok(lexicon.version(true).split('+').length === 3);
});

test('罕見字讀音表格式：一字一條、改讀為是常用字或「-」', () => {
  const lines = read('lib/tts-lexicon-rare.txt').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const l of lines) {
    const [ch, to] = l.split('｜');
    assert.strictEqual(Array.from(ch).length, 1, l);
    assert.ok(to === '-' || /^[一-鿿]$/.test(to), l);
  }
});

test('罕見字表在讀音表之後套用：改讀為不可是讀音表有單字規則的字（要寫最終讀法）', () => {
  // charMap 在讀音表之後才換字，換出來的字不會再經過讀音表；
  // 例：𣸩→突，但讀音表 突→圖（臺灣讀音），𣸩 就會被念成大陸音。
  const lexicon = require('../lib/tts-lexicon');
  const single = new Map(lexicon.entries(true).filter(([w]) => Array.from(w).length === 1));
  const bad = [];
  for (const [ch, to] of Object.entries(lexicon.charMap(true))) {
    if (to && single.has(to) && single.get(to) !== to) bad.push(`${ch}→${to}（讀音表 ${to}→${single.get(to)}）`);
  }
  assert.deepStrictEqual(bad, []);
});
