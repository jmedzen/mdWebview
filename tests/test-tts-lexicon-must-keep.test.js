'use strict';
/**
 * 朗讀讀音「必須保留」回歸測試。
 *
 * 2026-11-17：使用者要求的「縛→父」「闇→暗」（PR #243）一直停在未合併，dev 上看起來像「不見了」。
 * 這支測試把所有使用者要求過／校對過的讀法列在 tests/fixtures/tts-lexicon-must-keep.txt，
 * 只要有人刪掉、改掉內建讀音表的條目，或之後的改動（罕見字表、字典載入、斷句）讓實際朗讀不再這樣念，就會失敗。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用一份空白的自訂字典，避免讀到開發機上的 tts-lexicon.txt
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-must-keep-'));
process.env.TTS_LEXICON_PATH = path.join(TMP, 'tts-lexicon.txt');

const lexicon = require('../lib/tts-lexicon.js');
const Seg = require('../tts-segment.js');

const MUST_KEEP = fs.readFileSync(path.join(__dirname, 'fixtures', 'tts-lexicon-must-keep.txt'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== '#')
  .map((l) => l.split('｜').map((x) => x.trim()));

// 跟 lib/tts.js segmentOptions() 一樣（內建讀音表開啟，這是預設值）
const opts = () => ({ lexicon: lexicon.entries(true), charMap: lexicon.charMap(true) });
const say = (text) => Seg.oralize(text, 'sent', opts());

test('必須保留清單本身有內容，且包含使用者指定的 縛→父、闇→暗', () => {
  assert.ok(MUST_KEEP.length >= 70, `清單只剩 ${MUST_KEEP.length} 條`);
  const map = new Map(MUST_KEEP);
  assert.equal(map.get('縛'), '父');
  assert.equal(map.get('闇'), '暗');
  assert.equal(map.get('銀'), '吟');
  for (const [w, to] of MUST_KEEP) assert.ok(w && to, `格式錯誤：${w}｜${to}`);
});

test('每一條都還在內建佛經讀音表裡，讀法沒被改', () => {
  const builtin = new Map(lexicon.builtinRows().map((r) => [r.word, r.to]));
  const missing = []; const changed = [];
  for (const [w, to] of MUST_KEEP) {
    if (!builtin.has(w)) missing.push(w);
    else if (builtin.get(w) !== to) changed.push(`${w}：應為「${to}」，現在是「${builtin.get(w)}」`);
  }
  assert.deepEqual(missing, [], `內建讀音表少了：${missing.join('、')}`);
  assert.deepEqual(changed, [], changed.join('\n'));
});

test('實際朗讀（字典＋罕見字表）真的照清單念', () => {
  fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true }); lexicon.resetCache();
  const wrong = [];
  for (const [w, to] of MUST_KEEP) {
    // 「」在送出前換成“”（不也」｜否也」 這種以 」 當上下文的條目，實際送出的是「否也”」）
    const want = to.replace(/「/g, '“').replace(/」/g, '”');
    const got = say(w);
    if (got !== want) wrong.push(`${w}：應念「${want}」，實際送出「${got}」`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  // 句子裡的情況
  assert.equal(say('解脫諸縛，破無明闇'), '解脫諸父，破無明暗');
  assert.equal(say('繫縛'), '繫父');
  assert.equal(say('闇冥'), '暗冥');
  // 銀→吟（2026-11-17 使用者指定）；「銀行」的行要念 ㄏㄤˊ
  assert.equal(say('金銀琉璃，白銀為地'), '金吟琉璃，白吟為地');
  assert.equal(say('存入銀行'), '存入吟航');
  // 嶮→顯、杻→丑（2026-11-17 使用者指定）；罕見字 𡽗（嶮的異體）也要念「顯」
  assert.equal(say('險嶮之道'), '險顯之道');
  assert.equal(say('𡽗峻'), '顯峻');
  assert.equal(say('杻械枷鎖'), '丑械枷鎖');
  // 誑→狂（2026-11-17 使用者指定）；含「誑」的詞都念「狂」，罕見字 㾠（癲㾠）念「狂」，𣴥（烏光反）念「汪」
  assert.equal(say('不誑語者，不欺誑人'), '不狂語者，不欺狂人');
  assert.equal(say('誑惑眾生，諂誑妄語'), '狂惑眾生，諂狂妄語');
  assert.equal(say('𣴥水'), '汪水');
  assert.equal(say('㾠'), '狂');
  // 乾闥婆→前踏婆、不？→否？、不也→否也（2026-11-17 使用者指定）；「不」只在這兩個片語改讀
  assert.equal(say('天龍八部、乾闥婆、阿修羅'), '天龍八部、前踏婆、阿修羅');
  assert.equal(say('「於意云何？可以身相見如來不？」「不也，世尊！」'), '“於意云何？可以身相見如來否？”“否也，世尊！”');
  assert.equal(say('得福多不?'), '得福多否?');
  assert.equal(say('不也世尊'), '否也世尊');
  assert.equal(say('不可思議，不二法門，如如不動'), '不可思議，不二法門，如如不動');
  assert.equal(say('不入於色'), '不入於色');
  assert.equal(say('不也！善現。'), '否也！善現。');
  assert.equal(say('答曰：不也。'), '答曰：否也。');
  assert.equal(say('答言：「不也」'), '答言：“否也”');
  assert.equal(say('不也；世尊'), '否也；世尊');
  // 白話「難道不也…」不是答語：「不也」後面沒有標點就不改
  assert.equal(say('這不也是假名安立嗎？'), '這不也是假名安立嗎？');
  assert.equal(say('豈不也很精進？'), '豈不也很精進？');
});

test('整篇斷句後的朗讀文字也照清單念（segmentDoc 路徑）', () => {
  const doc = '# 測試\n\n解脫諸縛，破無明闇。\n';
  const out = Seg.segmentDoc(doc, Object.assign({ maxLen: 80 }, opts()));
  const spoken = JSON.stringify(out);
  assert.ok(spoken.includes('解脫諸父，破無明暗'), spoken.slice(0, 400));
});

test('自訂字典只寫斷句保護（預設內容）時，不會擋掉內建讀法', () => {
  fs.writeFileSync(process.env.TTS_LEXICON_PATH, lexicon.DEFAULT_TEXT + '\n縛\n闇\n');
  lexicon.resetCache();
  assert.equal(say('解脫諸縛，破無明闇'), '解脫諸父，破無明暗');
  fs.rmSync(process.env.TTS_LEXICON_PATH, { force: true }); lexicon.resetCache();
});
