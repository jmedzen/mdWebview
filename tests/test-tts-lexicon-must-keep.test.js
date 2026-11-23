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
  // 異體字換正字（2026-11-22 第二批全字掃描）：句子裡也換；正字本身有讀音規則的念最終讀法
  assert.equal(say('擧手，觧脫，氷水'), '舉手，解脫，冰水');
  assert.equal(say('如一渧水'), '如一滴水');
  assert.equal(say('冐地薩埵'), '冒地薩埵');
  assert.equal(say('倐忽'), '樹忽');
  assert.equal(say('旹'), '时');
  // 第二批簡體（2026-11-23）：異體字與罕見字表換出來的正字也要念最終的簡體
  assert.equal(say('諱莫如深，靈鷲山'), '讳莫如深，靈鹫山');
  assert.equal(say('覰'), '觑');
  assert.equal(say('㨑'), '踪');
  assert.equal(say('硨磲'), '車渠');
  // 第三批同音字（2026-11-23）：句子裡也換；異體字與罕見字也念到同一個字；宁 照原字念（當「寧」的簡體）
  assert.equal(say('廿一日，親戚'), '念一日，親七');
  assert.equal(say('卄'), '念');
  assert.equal(say('娑婆莎訶'), '娑婆梭呵');
  assert.equal(say('臝形，臝劣，飢臝'), '裸形，盈劣，飢盈');
  assert.equal(say('宁'), '宁');
  // 第五批臺灣讀音（2026-11-23）：單字換字（替代字皆單一讀音）、多音字依詞分開
  assert.equal(say('驟雨，淑女'), '奏雨，塾女');
  assert.equal(say('夾山寺，夾雜'), '郟山寺，夾雜');
  assert.equal(say('肋骨，肋下，雞肋'), '淚骨，淚下，雞淚');
  assert.equal(say('僧衹，衹園，衹有'), '僧旗，旗園，指有');
  assert.equal(say('爿聲，爿音，從爿'), '牆聲，牆音，從牆');
  assert.equal(say('樸素，樸實'), '普素，普實');
  // 讀誦→獨送（2026-11-17 使用者指定）；含「讀誦」的詞都念「獨送」，單獨的「讀」「誦」不變（大乘的乘另有 乘→聖）
  assert.equal(say('受持讀誦，為他人說'), '受持獨送，為他人說');
  assert.equal(say('讀誦大乘，書寫讀誦經典'), '獨送大聖，書寫獨送經典');
  assert.equal(say('讀經念佛，誦咒持名'), '讀經念佛，誦咒持名');
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
  // 咒語與罕用字一批（2026-11-17 使用者指定）
  assert.equal(say('天樂鳴空，雨眾妙華'), '天月鳴空，雨眾妙花');
  assert.equal(say('薄俱羅、鸚鵡、迦陵頻伽'), '薄句螺、鷹五、迦陵頻茄');
  assert.equal(say('伽哆 伽彌膩 伽伽那 抧多迦'), '茄多茄密逆茄茄那只多加');
  assert.equal(say('僧伽、伽藍、瑜伽'), '僧茄、茄藍、瑜伽'); // 單獨的「伽」照原字
  assert.equal(say('般若波羅蜜，般羅'), '波惹波羅蜜，波羅');
  assert.equal(say('持鉢乞食，鉢多羅，優曇鉢華'), '持波乞食，波多羅，優譚波華');
  assert.equal(say('阿㝹樓馱，䭾𨈷'), '阿耨樓陀，陀陀');
  assert.equal(say('懷孕，𣎜'), '懷韻，韻');
  assert.equal(say('㖿跢囇嘇'), '也多力森');
  assert.equal(say('誦呪，竪幢旛，功効'), '誦咒，束幢翻，功笑');
  assert.equal(say('心無罣㝵'), '心無掛礙');
  assert.equal(say('心無罣礙，無罣礙故'), '心無掛礙，無掛礙故');
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
