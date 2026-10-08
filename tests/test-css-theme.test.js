const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('CSS 樣式系統與 5 大主題完整性測試 (style.css)', () => {
  const cssPath = path.join(ROOT_DIR, 'style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  test('CSS 括號閉合完整性 (Brace Balance Check)', () => {
    // 移除字串與註解以精確統計大括號
    let sanitized = cssContent
      .replace(/\/\*[\s\S]*?\*\//g, '') // 移除 CSS 註解
      .replace(/"(?:[^"\\]|\\.)*"/g, '') // 移除雙引號字串
      .replace(/'(?:[^'\\]|\\.)*'/g, ''); // 移除單引號字串

    let depth = 0;
    let minDepth = 0;
    const lines = sanitized.split('\n');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth < minDepth) {
            minDepth = depth;
            assert.fail(`行 ${lineNum + 1}: 發現未匹配的右大括號 "}" (深度: ${depth})`);
          }
        }
      }
    }

    assert.equal(depth, 0, `CSS 大括號未閉合！未閉合深度: ${depth}`);
    assert.equal(minDepth, 0, 'CSS 不得出現提早閉合或多餘之右括號');
  });

  test('5 大主題定義完整性 (Obsidian Dark/Light, Solarized, Zen, Gruvbox)', () => {
    const expectedThemes = [
      'obsidian-dark',
      'obsidian-light',
      'solarized',
      'zen',
      'gruvbox'
    ];

    for (const theme of expectedThemes) {
      const regex = new RegExp(`\\[data-theme=["']${theme}["']\\]\\s*\\{([^}]+)\\}`, 'm');
      const match = cssContent.match(regex);
      assert.ok(match, `style.css 必須定義 [data-theme="${theme}"] 主題區塊`);

      const themeBody = match[1];
      const requiredVars = [
        '--bg-primary',
        '--bg-secondary',
        '--bg-tertiary',
        '--text-primary',
        '--text-secondary',
        '--text-muted',
        '--accent',
        '--border',
        '--sidebar-bg',
        '--heading-color',
        '--bold-color',
        '--link-color'
      ];

      for (const varName of requiredVars) {
        assert.ok(
          themeBody.includes(`${varName}:`),
          `主題 "${theme}" 必須包含核心變數 "${varName}"`
        );
      }
    }
  });

  test('html 全域回退 CSS 變數完整性 (Global Fallbacks)', () => {
    assert.ok(cssContent.includes('--text-normal: var(--text-primary);'), '應定義 --text-normal 回退');
    assert.ok(cssContent.includes('--border-color: var(--border);'), '應定義 --border-color 回退');
    assert.ok(cssContent.includes('--table-border-color: var(--border);'), '應定義 --table-border-color 回退');
    assert.ok(cssContent.includes('--accent-color: var(--accent);'), '應定義 --accent-color 回退');
    assert.ok(cssContent.includes('--bold-color: var(--accent);'), '應定義 --bold-color 回退');
  });

  test('響應式與無障礙設計樣式 (Responsive & Print)', () => {
    // 行動裝置斷點
    assert.ok(
      cssContent.includes('@media (max-width:') || cssContent.includes('@media screen and (max-width:'),
      '應包含行動裝置響應式媒體查詢'
    );

    // 列印樣式
    assert.ok(
      cssContent.includes('@media print'),
      '應包含 @media print 列印樣式定義'
    );
  });

  test('使用者偏好設定彈窗與簡繁轉換開關樣式 (User Settings & S2T Toggle)', () => {
    // 檢查使用者設定彈窗核心樣式
    assert.ok(cssContent.includes('.user-settings-card'), '應包含 .user-settings-card 樣式');
    assert.ok(cssContent.includes('.settings-tabs-nav'), '應包含 .settings-tabs-nav 分頁導覽樣式');
    assert.ok(cssContent.includes('.settings-tab-btn'), '應包含 .settings-tab-btn 分頁按鈕樣式');
    assert.ok(cssContent.includes('.settings-tab-pane'), '應包含 .settings-tab-pane 內容面板樣式');
    assert.ok(cssContent.includes('.toggle-switch'), '應包含 .toggle-switch 開關外框樣式');
    assert.ok(cssContent.includes('.toggle-slider'), '應包含 .toggle-slider 滑塊樣式');

    // index.html 應包含簡繁轉換開關控制項
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('settingAutoS2TCheck'), 'index.html 視覺排版中應具備 settingAutoS2TCheck');
  });
});
