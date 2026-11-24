// 後台總覽與導覽燈號（PR：總覽顯示朗讀預先生成、req/min、朗讀圖表提示框、補齊導覽燈號）
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('後台總覽與燈號', () => {
  test('總覽有朗讀預先生成卡片，可暫停／繼續', () => {
    assert.match(html, /id="ovPregenCard"[^>]*hidden/);
    assert.match(app, /data-ov-job-action="\$\{pause \? 'pause' : 'resume'\}"/);
    assert.match(app, /data-ov-job-all="pause"/);
    assert.match(app, /data-ov-job-all="resume"/);
  });

  test('總覽系統健康列出 req/min', () => {
    assert.match(app, /req\/min`, false\]/);
  });

  test('HTML 已有燈號的卡片不再補第二顆（綠點被擠到中間的原因）', () => {
    assert.match(app, /header\.querySelector\(':scope > \.status-light'\)/);
  });

  test('朗讀趨勢圖改用共用互動圖表，提示框有明細', () => {
    assert.match(html.length ? app : '', /function renderTtsAnalyticsTrend\(d\)/);
    assert.match(app, /tooltipExtra: \(i\) =>/);
    assert.match(app, /typeof opts\.tooltipExtra === 'function'/);
  });

  test('沒有卡片燈號的頁面也有燈', () => {
    for (const page of ['hardware', 'logs', 'analytics', 'suggest']) {
      assert.match(app, new RegExp(`setAdminPageLight\\('${page}'`), `頁面 ${page} 要有燈號`);
    }
    assert.match(app, /setAdminCardLight\('ttslexicon'/);
    assert.doesNotMatch(app, /L\('reading', 'off'\)/);
  });

  test('accountApi 遇到全站限速的 GET 會重試', () => {
    assert.match(app, /res\.status === 429 && method === 'GET'/);
  });
});
