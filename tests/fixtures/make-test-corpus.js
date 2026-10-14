#!/usr/bin/env node
'use strict';

/**
 * Deterministically generate the synthetic corpus used by the integration tests.
 *
 * The real test vault (a Buddhist canon) and `config.json` are developer-local,
 * git-ignored data. A clean CI checkout therefore has an empty `md/`, no
 * dictionary and no admin record, which made every vault-dependent integration
 * test fail instead of validating anything.
 *
 * Rather than weakening those tests with skip guards, this script synthesises a
 * corpus with the same *structural* properties the tests assert on:
 *
 *   - a small (< 1MB) sutra with no heading, so the document title falls back to
 *     the file name, and containing the expected body text
 *   - a large (>= 1MB) sutra with well over 1000 lines and many `##` sections,
 *     enough entries for the `from=10&to=15` deep-chunk boundary test
 *   - a large (>= 1MB) dictionary with well over 100 `### 【…】` entries
 *   - `config.json` enabling the dictionary and providing an admin record
 *
 * Everything is written to the same git-ignored paths a developer would use, so
 * the suite runs completely unmodified and the generated data can never land in
 * a commit. The output is byte-deterministic for a given target size.
 *
 * Usage:  node tests/fixtures/make-test-corpus.js
 * Env:    FIXTURE_TARGET_BYTES  minimum size of each large fixture (default 1.15MB)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_BYTES = parseInt(process.env.FIXTURE_TARGET_BYTES, 10) || 1_150_000;

const SMALL_REL = 'md/01-大正藏/03般若部類/T0251《般若波羅蜜多心經》.md';
const LARGE_REL = 'md/01-大正藏/14瑜伽部類/T1579《瑜伽師地論》.md';
const DICT_REL = 'dicts/南山律學辭典.md';

function write(relPath, text) {
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf-8');
  return Buffer.byteLength(text);
}

/**
 * Small sutra. Deliberately has NO heading: `extractMarkdownMetadata` then falls
 * back to the base name, which is exactly what the SSR title test expects.
 */
function buildSmall() {
  return [
    '//----------------------------------------------------------------------',
    '//【經文資訊】CI 合成測試語料（非真實經文）',
    '//----------------------------------------------------------------------',
    '',
    '般若波羅蜜多心經',
    '',
    '觀自在菩薩，行深般若波羅蜜多時，照見五蘊皆空，度一切苦厄。',
    '',
    '舍利子，色不異空，空不異色；色即是空，空即是色。',
    '',
    '受想行識，亦復如是。',
    '',
  ].join('\n');
}

/** Large sutra: many `##` sections so entries, chunks and deep ranges all exist. */
function buildLarge() {
  const paras = [
    '如是行者，於諸法中得如實智，遠離一切顛倒妄想；又諸菩薩觀諸法空，不生不滅，不垢不淨，不增不減。',
    '彌勒菩薩說，唐三藏法師玄奘奉詔譯，本地分中意地相應，廣辨諸法自性差別，令諸有情如實了知。',
    '云何名為本地分中五識身相應地？謂由五識身自性、所依、所緣、助伴、作業差別，而得建立。',
  ];
  let out = [
    '//----------------------------------------------------------------------',
    '//【經文資訊】CI 合成測試語料（非真實經文）',
    '//----------------------------------------------------------------------',
    '',
  ].join('\n');

  let bytes = Buffer.byteLength(out);
  let volume = 0;
  while (bytes < TARGET_BYTES) {
    volume++;
    let block = `\n## 卷${volume} 本地分\n\n`;
    for (let i = 0; i < paras.length; i++) block += paras[(volume + i) % paras.length] + '\n\n';
    out += block;
    bytes += Buffer.byteLength(block);
  }
  return { text: out, volumes: volume };
}

/** Large dictionary: many `### 【…】` entries, matching the real file's shape. */
function buildDict() {
  let out = '南山律學辭典-NanshanVinayaDictionary（CI 合成測試語料）\n\n';
  let bytes = Buffer.byteLength(out);
  let n = 0;
  while (bytes < TARGET_BYTES) {
    n++;
    const block =
      `### 【測試條目${n}】\n\n` +
      `亦名：別名${n}\n\n` +
      '子題：律、眾律、四尊、緣起、辨相開遮、法聚\n\n' +
      '含註戒本‧戒經序：「一切眾律中，戒經為上最。」（含註戒本卷上‧二‧一）\n\n' +
      `南山律學辭典第三門第 ${n} 條，用於驗證辭典章節索引、分塊邊界與深層跳轉行為。\n\n`;
    out += block;
    bytes += Buffer.byteLength(block);
  }
  return { text: out, entries: n };
}

/**
 * Minimal config: the dictionary must be enabled for `dict:` paths to resolve,
 * and `tests/test-logging.test.js` dereferences `config.admin` after restoring
 * the original value. `dictionaryPath` is intentionally omitted so it derives
 * from `mdRoot` (=> `<APP_ROOT>/dicts`).
 */
function buildConfig() {
  return JSON.stringify({
    admin: {
      username: 'ci-admin',
      // Not a real credential: only used to assert the hash never reaches a log.
      passwordHash: '0'.repeat(64),
      salt: 'ci-test-salt',
    },
    settings: {
      siteName: 'mdWebview CI',
      dictionaryEnabled: true,
    },
  }, null, 2) + '\n';
}

function main() {
  const small = write(SMALL_REL, buildSmall());
  const large = buildLarge();
  const dict = buildDict();

  write(LARGE_REL, large.text);
  write(DICT_REL, dict.text);
  write('config.json', buildConfig());

  console.log('[fixtures] synthetic test corpus written under ' + ROOT);
  console.log(`[fixtures]   ${SMALL_REL} (${small} B)`);
  console.log(`[fixtures]   ${LARGE_REL} (${Buffer.byteLength(large.text)} B, ${large.volumes} sections)`);
  console.log(`[fixtures]   ${DICT_REL} (${Buffer.byteLength(dict.text)} B, ${dict.entries} entries)`);
  console.log('[fixtures]   config.json (dictionaryEnabled=true, admin set)');
}

main();
