const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('媒體檔案全螢幕燈箱與縮放平移功能測試 (Media Lightbox with Zoom & Pan)', () => {
  const htmlPath = path.join(ROOT_DIR, 'index.html');
  const cssPath = path.join(ROOT_DIR, 'style.css');
  const appJsPath = path.join(ROOT_DIR, 'app.js');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('1. index.html 燈箱 DOM 結構完整性驗證', () => {
    // 燈箱根節點與深色遮罩
    assert.match(htmlContent, /id="mediaLightboxOverlay"/, '必須包含燈箱根節點 #mediaLightboxOverlay');
    assert.match(htmlContent, /id="mediaLightboxBackdrop"/, '必須包含半透明黑框背景 #mediaLightboxBackdrop');

    // 工具列與控制按鈕
    assert.match(htmlContent, /id="mediaLightboxToolbar"/, '必須包含頂部控制工具列 #mediaLightboxToolbar');
    assert.match(htmlContent, /id="mediaLightboxZoomOutBtn"/, '必須包含縮小按鈕 #mediaLightboxZoomOutBtn');
    assert.match(htmlContent, /id="mediaLightboxScaleText"/, '必須包含縮放比例文字 #mediaLightboxScaleText');
    assert.match(htmlContent, /id="mediaLightboxZoomInBtn"/, '必須包含放大按鈕 #mediaLightboxZoomInBtn');
    assert.match(htmlContent, /id="mediaLightboxCloseBtn"/, '必須包含關閉按鈕 #mediaLightboxCloseBtn');

    // 視口、可變形畫布與圖片節點
    assert.match(htmlContent, /id="mediaLightboxViewport"/, '必須包含手勢視口 #mediaLightboxViewport');
    assert.match(htmlContent, /id="mediaLightboxCanvas"/, '必須包含可變形畫布容器 #mediaLightboxCanvas');
    assert.match(htmlContent, /id="mediaLightboxImg"/, '必須包含燈箱圖片節點 #mediaLightboxImg');
    assert.match(htmlContent, /id="mediaLightboxCaption"/, '必須包含圖片說明標籤 #mediaLightboxCaption');
  });

  test('2. style.css 燈箱與游標樣式完整性驗證', () => {
    // 文檔內圖片應有放大手勢提示
    assert.match(cssContent, /\.markdown-body\s+img[\s\S]*?cursor:\s*zoom-in/, 'Markdown 正文圖片應具有 cursor: zoom-in 提示');

    // 燈箱本體層級與半透明黑框毛玻璃樣式
    assert.match(cssContent, /\.media-lightbox-overlay\s*\{[\s\S]*?z-index:\s*2100/, '燈箱遮罩層級 z-index 應設為 2100（高於其他 UI 與 modal）');
    assert.match(cssContent, /\.media-lightbox-backdrop\s*\{[\s\S]*?rgba\(0,\s*0,\s*0,\s*0\.86\)/, '背景遮罩應為半透明黑框 (rgba(0,0,0,0.86))');
    assert.match(cssContent, /\.media-lightbox-backdrop\s*\{[\s\S]*?backdrop-filter:\s*blur\(12px\)/, '背景遮罩應具有毛玻璃模糊效果 (backdrop-filter: blur(12px))');

    // 視口與平移游標樣式
    assert.match(cssContent, /\.media-lightbox-viewport\s*\{[\s\S]*?cursor:\s*grab/, '視口預設游標應為 grab');
    assert.match(cssContent, /\.media-lightbox-viewport\.is-dragging\s*\{[\s\S]*?cursor:\s*grabbing/, '視口拖曳中游標應為 grabbing');
    assert.match(cssContent, /\.media-lightbox-canvas\s*\{[\s\S]*?will-change:\s*transform/, '畫布應具備 will-change: transform 硬體加速提示');
  });

  test('3. app.js 核心函式與狀態控制完整性驗證', () => {
    // 檢查核心函式定義
    assert.match(appJsContent, /function\s+openMediaLightbox\s*\(/, 'app.js 必須實作 openMediaLightbox');
    assert.match(appJsContent, /function\s+closeMediaLightbox\s*\(/, 'app.js 必須實作 closeMediaLightbox');
    assert.match(appJsContent, /function\s+zoomLightboxAt\s*\(/, 'app.js 必須實作以焦點為中心的 zoomLightboxAt');
    assert.match(appJsContent, /function\s+resetLightboxZoom\s*\(/, 'app.js 必須實作 resetLightboxZoom');
    assert.match(appJsContent, /function\s+initMediaLightboxEvents\s*\(/, 'app.js 必須實作 initMediaLightboxEvents');

    // 檢查縮放邊界與手勢控制
    assert.match(appJsContent, /MIN_SCALE\s*=\s*0\.5/, '燈箱最小縮放比例應限制在 0.5x');
    assert.match(appJsContent, /MAX_SCALE\s*=\s*8\.0/, '燈箱最大縮放比例應限制在 8.0x');

    // 檢查全域測試介面導出
    assert.match(appJsContent, /window\.openMediaLightbox\s*=\s*openMediaLightbox/, '應掛載 window.openMediaLightbox 便於呼叫與測試');
    assert.match(appJsContent, /window\.closeMediaLightbox\s*=\s*closeMediaLightbox/, '應掛載 window.closeMediaLightbox 便於呼叫與測試');
    assert.match(appJsContent, /window\.mediaLightboxState\s*=\s*mediaLightboxState/, '應掛載 window.mediaLightboxState 便於狀態驗證');
  });

  test('4. app.js 正文圖片點擊委派與防誤觸機制驗證', () => {
    // 正文圖片點擊喚起燈箱且阻斷預設跳轉（例如圖文超連結 a 包裹 img）
    assert.match(appJsContent, /imgEl\s*&&\s*\$\('markdownBody'\)\.contains\(imgEl\)/, '點擊圖片時應檢驗是否位於 markdownBody 內部');
    assert.match(appJsContent, /openMediaLightbox\(imgEl\.src,\s*imgEl\.getAttribute\('alt'\)/, '點擊圖片應呼叫 openMediaLightbox 傳入 src 與 alt');

    // 雙擊縮放（Double click toggle 1x <-> 2.5x）
    assert.match(appJsContent, /viewport\.addEventListener\('dblclick'/, '視口應監聽 dblclick 進行快速放大縮小切換');

    // 鍵盤 Esc 鍵與快速鍵綁定
    assert.match(appJsContent, /e\.key\s*===\s*'Escape'/, '按下 Escape 鍵應能關閉燈箱');
  });
});
