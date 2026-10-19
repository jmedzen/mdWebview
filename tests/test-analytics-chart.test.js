const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

/** 從 app.js 抽出指定函式的原始碼（含大括號配對） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js 應包含函式 ${name}()`);
  let depth = 0;
  const braceStart = src.indexOf('{', start);
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函式 ${name}() 的大括號不平衡`);
}

/** 取得 style.css 中某個選擇器的宣告區塊 */
function cssRuleBlock(selector) {
  const idx = STYLE_CSS.indexOf(`${selector} {`);
  assert.notEqual(idx, -1, `style.css 應包含選擇器 ${selector}`);
  const end = STYLE_CSS.indexOf('}', idx);
  return STYLE_CSS.slice(idx, end + 1);
}

const CHART_SRC = extractFunction(APP_JS, 'renderAnalyticsTrendChart');
const NICE_SCALE_SRC = extractFunction(APP_JS, 'computeNiceScale');
const MONOTONE_SRC = extractFunction(APP_JS, 'monotonePath');

// 讓測試可以直接呼叫純函式
const computeNiceScale = new Function(`${NICE_SCALE_SRC}; return computeNiceScale;`)();
const monotonePath = new Function(`${MONOTONE_SRC}; return monotonePath;`)();

describe('後台流量趨勢圖 — Y 軸刻度 (computeNiceScale)', () => {
  test('刻度必為整數、不重複，且涵蓋最大值', () => {
    for (const maxValue of [1, 2, 5, 7, 12, 25, 100, 1234, 9999]) {
      const { max, step } = computeNiceScale(maxValue, 4);
      assert.ok(Number.isInteger(max), `上限應為整數，得到 ${max}`);
      assert.ok(Number.isInteger(step), `步長應為整數，得到 ${step}`);
      assert.ok(step >= 1, `步長至少為 1，得到 ${step}`);
      assert.ok(max >= maxValue, `上限 ${max} 應涵蓋最大值 ${maxValue}`);

      const ticks = [];
      for (let v = 0; v <= max; v += step) ticks.push(v);
      assert.equal(new Set(ticks).size, ticks.length,
        `刻度不應重複：${JSON.stringify(ticks)}`);
    }
  });

  test('常見最大值 100 應產生 0/25/50/75/100 而非稀疏的三格', () => {
    const { max, step } = computeNiceScale(100, 4);
    assert.equal(max, 100);
    assert.equal(step, 25, '舊版以 frac<=2/5 判斷會退化成步長 50，只有三個刻度');
  });

  test('資料全為 0 時仍要有可繪製的刻度（不可除以零）', () => {
    const { max, step } = computeNiceScale(0, 4);
    assert.ok(max >= 1, '零資料仍需有正的座標上限');
    assert.ok(step >= 1);
  });
});

describe('後台流量趨勢圖 — 平滑曲線 (monotonePath)', () => {
  test('三點以上使用三次貝茲曲線而非折線', () => {
    const d = monotonePath([{ x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 }]);
    assert.match(d, /^M /, '應以 M 起頭');
    assert.match(d, / C /, '應包含 C 曲線指令');
  });

  test('單點與兩點退化情況不應產生 C 指令', () => {
    assert.equal(monotonePath([]), '');
    assert.match(monotonePath([{ x: 10, y: 20 }]), /^M 10,20$/);
    const two = monotonePath([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    assert.ok(!two.includes('C'), '兩點應以直線連接，不需曲線');
  });

  test('不得 overshoot 到資料範圍之外（會畫到座標軸外）', () => {
    // 急升後急降：Catmull-Rom 之類的演算法會在這裡爆衝到負值
    const pts = [{ x: 0, y: 180 }, { x: 100, y: 20 }, { x: 200, y: 180 }];
    const d = monotonePath(pts);
    const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map(m => parseFloat(m[1]));
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    assert.ok(minY >= 20 - 1e-6, `曲線最低點 ${minY} 不應低於資料最小值 20`);
    assert.ok(maxY <= 180 + 1e-6, `曲線最高點 ${maxY} 不應高於資料最大值 180`);
  });

  test('平台段（相鄰同值）應保持水平，不可產生波動', () => {
    const d = monotonePath([
      { x: 0, y: 50 }, { x: 10, y: 50 }, { x: 20, y: 50 }, { x: 30, y: 50 },
    ]);
    const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map(m => parseFloat(m[1]));
    assert.ok(ys.every(y => Math.abs(y - 50) < 1e-6), `平台段應維持 y=50，得到 ${ys}`);
  });
});

describe('後台流量趨勢圖 — 整片垂直感應區（滑鼠更容易觸發細部數據）', () => {
  test('必須渲染覆蓋整個 SVG 的感應矩形', () => {
    assert.match(CHART_SRC, /class="chart-hit-area"/, '應有 .chart-hit-area 感應矩形');
    // 感應矩形要鋪滿 viewBox，而不是只包住資料點
    assert.match(CHART_SRC, /class="chart-hit-area"[^>]*width="\$\{width\}"/s,
      '感應區寬度應等於整個圖表寬度');
    assert.match(CHART_SRC, /class="chart-hit-area"[^>]*height="\$\{height\}"/s,
      '感應區高度應等於整個圖表高度');
    assert.match(CHART_SRC, /class="chart-hit-area"\s+x="0"\s+y="0"|x="0"\s+y="0"[^>]*chart-hit-area/s,
      '感應區應從原點 (0,0) 開始');
  });

  test('感應區必須是最後一個圖形，才能蓋在折線與資料點之上', () => {
    const hitIdx = CHART_SRC.indexOf('chart-hit-area');
    const lastDotIdx = CHART_SRC.indexOf('${dots}');
    const lastFocusIdx = CHART_SRC.indexOf('trend-focus-ip');
    assert.ok(hitIdx > lastDotIdx, '感應區應排在資料點之後');
    assert.ok(hitIdx > lastFocusIdx, '感應區應排在聚焦點之後');
  });

  test('垂直方向不應影響日期判定（只看水平距離）', () => {
    assert.match(CHART_SRC, /Math\.abs\(getX\(i\) - svgX\)/,
      '應用水平距離找最近的資料點');
    assert.ok(!/Math\.abs\([^)]*getY/.test(CHART_SRC.split('showTooltip')[1] || ''),
      '垂直座標不應參與最近的資料點計算，否則只有資料點附近能觸發');
  });

  test('互動綁定於整片感應區，而非單一資料點', () => {
    assert.match(CHART_SRC, /hitArea\.addEventListener\('pointermove'/,
      '應在感應區綁定 pointermove');
    // 舊實作逐一綁定 .trend-dot 的 mouseenter，感應範圍只有直徑數 px
    assert.ok(!/querySelectorAll\('\.trend-dot'\)/.test(CHART_SRC),
      '不應再逐一綁定 .trend-dot（那正是感應範圍過小的原因）');
    assert.ok(!/addEventListener\('mouseenter'/.test(CHART_SRC),
      '不應使用 mouseenter（觸控裝置不會觸發）');
  });

  test('離開感應區時必須隱藏提示框與輔助線', () => {
    assert.match(CHART_SRC, /hitArea\.addEventListener\('pointerleave', hideTooltip\)/);
    assert.match(CHART_SRC, /hitArea\.addEventListener\('pointercancel', hideTooltip\)/);
    const hideBlock = CHART_SRC.slice(CHART_SRC.indexOf('const hideTooltip'));
    assert.match(hideBlock, /tooltip\.style\.display = 'none'/,
      '隱藏時應一併關閉提示框');
    assert.match(hideBlock, /cursor\.style\.opacity = '0'/,
      '隱藏時應一併淡出垂直輔助線');
  });

  test('應有垂直游標輔助線與聚焦點', () => {
    assert.match(CHART_SRC, /class="chart-cursor-line"/, '應渲染 .chart-cursor-line');
    assert.match(CHART_SRC, /class="trend-focus trend-focus-view"/, '應有主線聚焦點');
    assert.match(CHART_SRC, /class="trend-focus trend-focus-ip"/, '應有訪客線聚焦點');
  });

  test('CSS 應為感應區設定 crosshair 游標', () => {
    const block = cssRuleBlock('.chart-hit-area');
    assert.match(block, /cursor:\s*crosshair/, '感應區應顯示十字游標，提示可互動');
  });
});

describe('後台流量趨勢圖 — 視覺樣式', () => {
  test('顏色應走主題變數，而非寫死色碼', () => {
    assert.match(cssRuleBlock('.trend-line-views'), /stroke:\s*var\(--accent\)/,
      '主線顏色應跟隨主題 accent');
    assert.match(cssRuleBlock('.trend-grid-line'), /stroke:\s*var\(--border-subtle\)/,
      '格線顏色應跟隨主題');
    assert.match(cssRuleBlock('.trend-axis-label'), /fill:\s*var\(--text-muted\)/,
      '軸標籤顏色應跟隨主題');
    // 漸層三段都必須用主題色
    for (const cls of ['.trend-grad-0', '.trend-grad-1', '.trend-grad-2']) {
      assert.match(cssRuleBlock(cls), /stop-color:\s*var\(--accent\)/,
        `${cls} 應使用主題 accent 色`);
    }
  });

  test('漸層透明度應由深到淺遞減，形成面積淡出效果', () => {
    const opacities = ['.trend-grad-0', '.trend-grad-1', '.trend-grad-2'].map(cls => {
      const m = cssRuleBlock(cls).match(/stop-opacity:\s*([\d.]+)/);
      assert.ok(m, `${cls} 應宣告 stop-opacity`);
      return parseFloat(m[1]);
    });
    assert.ok(opacities[0] > opacities[1] && opacities[1] > opacities[2],
      `透明度應遞減，得到 ${opacities.join(' > ')}`);
    assert.equal(opacities[2], 0, '最底層應完全透明，避免面積區塊出現硬邊');
  });

  test('獨立訪客線應為虛線以便與主線區分', () => {
    assert.match(cssRuleBlock('.trend-line-ips'), /stroke-dasharray:\s*\d/,
      '訪客線應使用虛線');
  });

  test('提示框底色必須跟隨主題（淺色主題下不可仍是深底深字）', () => {
    const block = cssRuleBlock('.chart-floating-tooltip');
    assert.ok(!/background:\s*rgba\(22,\s*27,\s*34/.test(block),
      '不可再寫死深色底：obsidian-light / zen 會變成深底深字，對比僅 1.4～2.2');
    assert.match(block, /background:\s*var\(--bg-(tertiary|secondary|elevated)\)/,
      '提示框底色應使用主題變數');
    assert.match(block, /color:\s*var\(--text-primary\)/,
      '提示框文字應使用主題變數');
  });

  test('提示框位置由 JS 像素計算，CSS 不應再做位移', () => {
    const block = cssRuleBlock('.chart-floating-tooltip');
    assert.match(block, /transform:\s*none/,
      'JS 已算出實際左上角，CSS 再位移會讓提示框壓到資料點上');
  });

  test('提示框應放在游標線側邊，避免蓋住資料點', () => {
    // 兩個資料點都在游標線正上方，往上或往下放都必定蓋掉其中一個
    assert.match(CHART_SRC, /let left = anchorX \+ GAP/, '應優先放在右側');
    assert.match(CHART_SRC, /left = anchorX - GAP - tw/, '右側空間不足時改放左側');
    // 絕對定位的包含區塊是父層 padding box，原點只加 border，不可重複加 padding
    assert.match(CHART_SRC, /wrapRect\.left \+ \(parseFloat\(cs\.borderLeftWidth\)/,
      '座標原點應為 border 內緣（padding box 起點），不可再加 padding');
  });

  test('提示框應夾在容器內，不超出左右邊界', () => {
    assert.match(CHART_SRC, /Math\.max\(0, Math\.min\(left, Math\.max\(0, innerW - tw\)\)\)/,
      'left 應被夾在容器可用寬度內');
    assert.match(CHART_SRC, /Math\.max\(0, Math\.min\(svgTop, Math\.max\(0, innerH - th\)\)\)/,
      'top 應被夾在容器可用高度內');
  });

  test('圖例應使用結構化樣式類別而非行內樣式', () => {
    assert.match(CHART_SRC, /class="analytics-chart-legend"/, '應有圖例容器');
    assert.equal((CHART_SRC.match(/class="chart-legend-item"/g) || []).length, 2,
      '應有兩個圖例項目');
    assert.match(CHART_SRC, /chart-legend-line is-dashed/, '訪客圖例應為虛線樣式');
    assert.ok(!/class="analytics-chart-legend"\s+style=/.test(CHART_SRC),
      '圖例不應再使用行內樣式，否則無法跟隨主題');
  });
});

describe('後台流量趨勢圖 — 邊界與安全性', () => {
  test('空資料應顯示佔位訊息而非空白 SVG', () => {
    assert.match(CHART_SRC, /尚無趨勢數據/, '空資料應有提示文字');
  });

  test('缺少容器元素時應安全返回', () => {
    assert.match(CHART_SRC, /if \(!wrapper\) return;/, '找不到容器時不可拋錯');
  });

  test('日期文字必須經過 HTML 轉義', () => {
    assert.match(CHART_SRC, /escHtml\(String\(point\.date/,
      '提示框內的日期應經 escHtml 轉義，避免注入');
    assert.match(CHART_SRC, /escHtml\(short\)/, '軸標籤文字應經 escHtml 轉義');
  });

  test('數值應做整數化與千分位，避免出現 NaN 或 undefined', () => {
    assert.match(CHART_SRC, /Number\(d\.views\) \|\| 0/,
      'views 應正規化為數字，避免 undefined 讓路徑出現 NaN');
    assert.match(CHART_SRC, /Number\(d\.uniqueIps\) \|\| 0/,
      'uniqueIps 應正規化為數字');
    assert.match(CHART_SRC, /toLocaleString\(\)/, '數值應有千分位以利閱讀');
  });

  test('Y 值必須被夾在上限內，超出時不得畫到圖表外', () => {
    assert.match(CHART_SRC, /Math\.min\(Number\(v\) \|\| 0, maxY\)/,
      'getY 應把數值夾在 maxY 內');
  });
});
