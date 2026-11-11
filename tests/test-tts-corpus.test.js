/**
 * 朗讀斷句的語料驗證：對實際經文庫（MD_ROOT 或 config.json 的 mdRoot）抽樣，檢查不變式。
 * 經文庫沒有足夠的檔案時（例如 CI 的空 md/）整組跳過。
 *
 *   - 散文句不超過句長上限；章節連續涵蓋所有單位、細切後不超過 5000 字
 *   - 只重新斷某一段落，結果與整篇斷句的那一段相同（選取與預先生成共用快取的前提）
 *   - 隨機選取吸附後播放的句子，全部是整篇斷句的句子
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Seg = require('../tts-segment.js');
const { resolveTestMdRoot } = require('./helpers/md-root');

const MAX_FILES = 40;
const MAX_BYTES = 600 * 1024;

function sampleFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); } else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(root, 0);
  if (out.length <= MAX_FILES) return out;
  const step = out.length / MAX_FILES; // 等距抽樣：各資料夾都抽得到，而且每次相同
  return Array.from({ length: MAX_FILES }, (_, i) => out[Math.floor(i * step)]);
}

let seed = 20261111;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

describe('朗讀斷句：實際經文庫抽樣', () => {
  const root = resolveTestMdRoot();
  const files = fs.existsSync(root) ? sampleFiles(root).filter((f) => { try { return fs.statSync(f).size <= MAX_BYTES; } catch (_) { return false; } }) : [];
  const skip = files.length < 5 ? `經文庫只有 ${files.length} 個可用的 .md，跳過語料驗證` : false;

  test('句長、章節、段落局部性、選取重用', { skip }, () => {
    let voiced = 0; let selections = 0;
    for (const f of files) {
      const doc = fs.readFileSync(f, 'utf8');
      const { units } = Seg.segmentDoc(doc);
      const rel = path.relative(root, f);
      for (const u of units) {
        if (u.kind === 'skip') { assert.equal(u.spoken, undefined); continue; }
        voiced++;
        assert.ok(u.spoken && u.spoken.length > 0, `${rel}: empty spoken at line ${u.line}`);
        if (u.kind === 'sent' || u.kind === 'intro' || u.kind === 'mantra') assert.ok(u.text.length <= 120, `${rel}:${u.line} sentence of ${u.text.length} chars`);
        assert.ok(u.endLine >= u.line && u.a >= 0 && (u.endLine > u.line || u.b > u.a));
      }
      const { chapters } = Seg.detectChapters(units);
      if (units.length) {
        assert.equal(chapters[0].from, 0, rel);
        assert.equal(chapters[chapters.length - 1].to, units.length, rel);
        for (let i = 1; i < chapters.length; i++) assert.equal(chapters[i].from, chapters[i - 1].to, rel);
        // 單一句子本身就超過 5000 字不可能發生；單一段落超大時會退到句子邊界切
        for (const c of chapters) assert.ok(c.chars <= 5200, `${rel}: chapter of ${c.chars} chars`);
      }
      // 段落局部性：抽幾個段落單獨重切
      const all = new Set(units.filter((u) => u.spoken).map((u) => u.spoken));
      const lines = doc.split('\n');
      const voicedUnits = units.filter((u) => u.kind !== 'skip' && u.kind !== 'heading');
      for (let k = 0; k < 6 && voicedUnits.length; k++) {
        const u = voicedUnits[Math.floor(rnd() * voicedUnits.length)];
        let s = u.line - 1, e = u.endLine - 1;
        while (s > 0 && lines[s - 1].trim()) s--;
        while (e < lines.length - 1 && lines[e + 1].trim()) e++;
        const local = Seg.segmentDoc(lines.slice(s, e + 1).join('\n') + '\n').units.filter((x) => x.spoken && x.kind !== 'heading');
        const expected = units.filter((x) => x.block === u.block && x.spoken && x.kind !== 'heading').map((x) => x.spoken);
        // 「非經文區段」是文件層級的狀態（整篇斷句時標成 skip），單獨重切時可能多出單位：只要求整篇的句子都在
        const localSet = new Set(local.map((x) => x.spoken));
        for (const sp of expected) assert.ok(localSet.has(sp), `${rel}:${u.line} block-local mismatch`);
        // 選取吸附：在這句裡隨機選幾個字
        const a = u.a + Math.floor(rnd() * Math.max(1, u.text.length - 2));
        const r = Seg.snapSelection(units, { line: u.line, off: a }, { line: u.line, off: a + 2 });
        if (u.endLine === u.line) {
          assert.ok(r, `${rel}:${u.line} selection inside a sentence found nothing`);
          assert.ok(r.from <= u.i && r.to >= u.i);
          for (let i = r.from; i <= r.to; i++) if (units[i].spoken) assert.ok(all.has(units[i].spoken));
          selections++;
        }
      }
    }
    assert.ok(voiced > 0 && selections > 0);
  });
});
