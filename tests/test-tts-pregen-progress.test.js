// 預先生成進度用「句」算（已處理幾句／共幾句），不用「第幾部經」
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start > 0, `找不到 ${name}`);
  let i = app.indexOf('{', start); let depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) break;
  }
  return app.slice(start, i + 1);
}
// eslint-disable-next-line no-new-func
const ttsJobProgress = new Function(`${extract('ttsJobProgress')}; return ttsJobProgress;`)();

describe('預先生成進度（句）', () => {
  test('有總句數：已處理／總句數與百分比', () => {
    const p = ttsJobProgress({ state: 'running', files: 40, fileIndex: 1, sentencesDone: 2546, sentencesTotal: 10182 });
    assert.equal(p.pct, 25);
    assert.equal(p.text, '已處理 2,546／10,182 句（25%）');
  });

  test('大經在前：用句算不會因為只做完第 1 部就停在 2%', () => {
    const p = ttsJobProgress({ state: 'running', files: 50, fileIndex: 1, sentencesDone: 8000, sentencesTotal: 10000, current: null });
    assert.equal(p.pct, 80);
  });

  test('總句數還在算：文字只說已處理幾句，百分比先用篇數粗估', () => {
    const p = ttsJobProgress({ state: 'running', files: 4, fileIndex: 1, sentencesDone: 120, sentencesTotal: null, current: { done: 5, total: 10 } });
    assert.equal(p.total, null);
    assert.equal(p.pct, 37);
    assert.match(p.text, /已處理 120 句（總句數計算中）/);
  });

  test('完成＝100%；已處理不會超過總句數', () => {
    assert.equal(ttsJobProgress({ state: 'done', files: 3, fileIndex: 3, sentencesDone: 9, sentencesTotal: 9 }).pct, 100);
    const p = ttsJobProgress({ state: 'running', files: 3, fileIndex: 2, sentencesDone: 12, sentencesTotal: 10 });
    assert.equal(p.total, 12);
    assert.equal(p.pct, 100);
  });

  test('後台兩處進度都不再顯示「第幾篇／共幾篇」', () => {
    assert.doesNotMatch(app, /第 \$\{Math\.min\(j\.fileIndex/);
    assert.doesNotMatch(app, /<progress max="\$\{j\.files\}"/);
    assert.match(app, /const prog = ttsJobProgress\(j\);[\s\S]{0,200}const pct = prog\.pct;/);
  });
});
