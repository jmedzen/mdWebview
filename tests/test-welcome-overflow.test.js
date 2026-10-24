const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

/** 取出某個選擇器的第一條 CSS 規則主體（含巢狀大括號配對），並移除註解。 */
function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{`);
  const m = re.exec(source);
  if (!m) return '';
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) {
        // 規則內常帶說明註解，其中可能出現與宣告相同的字樣（例如解釋為何
        // 不能用 height: 100%），必須先剝除才不會誤判。
        return source.slice(i + 1, j).replace(/\/\*[\s\S]*?\*\//g, '');
      }
    }
  }
  return '';
}

describe('首頁歡迎畫面垂直溢出防護', () => {
  // 這個 bug 的症狀：iPhone 首頁最上方的蓮花整個消失，而且在畫面上怎麼滑
  // 都不會出現——因為它被推到「捲動原點之上」，那裡沒有任何捲動空間。
  //
  // 成因是 .welcome-screen 同時用了 height: 100% 與 justify-content: center。
  // 內容一旦超過容器高度，flex 置中會讓上下兩端同時溢出；下方溢出可以往下
  // 捲，上方溢出則永遠搆不到。安裝引導卡片（約 163px）正好把原本勉強塞得下
  // 的首頁推過了臨界點（iPhone SE 實測：內容 702px、容器 619px、蓮花 top −33px）。
  //
  // 修法是改用 min-height，讓容器隨內容成長，溢出交給父層的 overflow-y 處理。

  test('.welcome-screen 不得使用固定 height: 100%', () => {
    const body = ruleBody(styleCss, '.welcome-screen');
    assert.ok(body, '應能找到 .welcome-screen 規則');
    assert.doesNotMatch(
      body,
      /(^|[^-])height:\s*100%/,
      '.welcome-screen 不可用 height: 100%——內容超高時會把頂端推出可捲動範圍，造成蓮花消失'
    );
  });

  test('.welcome-screen 應以 min-height 撐開，讓內容超高時可捲動', () => {
    const body = ruleBody(styleCss, '.welcome-screen');
    assert.match(
      body,
      /min-height:\s*100%/,
      '.welcome-screen 應使用 min-height: 100%，使容器隨內容成長'
    );
  });

  test('.welcome-screen 應保留置中效果（內容較矮時仍美觀）', () => {
    const body = ruleBody(styleCss, '.welcome-screen');
    assert.match(body, /justify-content:\s*center/, '內容未溢出時仍應垂直置中');
  });

  test('首頁應含蓮花與安裝卡片，兩者都在同一個捲動容器內', () => {
    assert.match(indexHtml, /class="welcome-lotus"/, '首頁應有蓮花元素');
    assert.match(indexHtml, /id="installCard"/, '首頁應有安裝卡片');

    const lotusIdx = indexHtml.indexOf('class="welcome-lotus"');
    const cardIdx = indexHtml.indexOf('id="installCard"');
    const welcomeEnd = indexHtml.indexOf('id="contentWrapper"');
    assert.ok(lotusIdx > 0 && cardIdx > lotusIdx, '安裝卡片應位於蓮花之後');
    assert.ok(welcomeEnd > cardIdx, '安裝卡片必須在 welcomeScreen 內，才會隨首頁一起捲動');
  });
});
