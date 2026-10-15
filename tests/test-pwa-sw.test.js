const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** 取出 sw.js 內 CONTENT_PATHS 陣列的字串項目。 */
function parseContentPaths(swContent) {
  const m = swContent.match(/const\s+CONTENT_PATHS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('PWA 與 Service Worker (sw.js) 離線快取測試', () => {
  const swContent = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

  test('CACHE_VERSION 與 package.json 版本保持一致', () => {
    const versionMatch = swContent.match(/CACHE_VERSION\s*=\s*['"]v?([^'"]+)['"]/);
    assert.ok(versionMatch, 'sw.js 應定義 CACHE_VERSION');
    assert.equal(versionMatch[1], pkg.version, `sw.js 快取版本 (${versionMatch[1]}) 應與 package.json (${pkg.version}) 一致`);
  });

  test('index.html 內所有靜態資源查詢參數 ?v= 版本必須與 package.json 一致', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    const versionMatches = [...indexHtml.matchAll(/\?v=([^"'&>\s]+)/g)];
    assert.ok(
      versionMatches.length > 0,
      'index.html 內必須包含至少一個 ?v= 靜態資源快取破壞參數'
    );

    const mismatches = [];
    for (const match of versionMatches) {
      const ver = match[1];
      if (ver !== pkg.version) {
        mismatches.push(ver);
      }
      assert.equal(
        ver,
        pkg.version,
        `index.html 內的 ?v= 版本 "${ver}" 應與 package.json 版本 "${pkg.version}" 一致`
      );
    }

    assert.equal(
      mismatches.length,
      0,
      `index.html 內存在不符 package.json (${pkg.version}) 的版本參數: ${mismatches.join(', ')}`
    );
  });

  test('sw.js 的 SHELL_ASSETS 快取項目版本一致性檢驗', () => {
    const assetsMatch = swContent.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(assetsMatch, 'sw.js 應包含 SHELL_ASSETS 定義');

    const rawItems = assetsMatch[1]
      .split('\n')
      .map(line => line.trim().replace(/^['"]|['"],?$/g, ''))
      .filter(item => item && !item.startsWith('//'));

    const versionedItems = rawItems.filter(item => item.includes('?v='));
    if (versionedItems.length > 0) {
      for (const item of versionedItems) {
        const match = item.match(/\?v=([^"'&>\s]+)/);
        assert.ok(match, `SHELL_ASSETS 項目 "${item}" 應能解析 ?v= 版本號`);
        assert.equal(
          match[1],
          pkg.version,
          `SHELL_ASSETS 項目 "${item}" 的版本 "${match[1]}" 應與 package.json (${pkg.version}) 一致`
        );
      }
    } else {
      // 若 SHELL_ASSETS 不含 ?v=，明確 assert 其不含，避免未來不一致
      assert.equal(
        versionedItems.length,
        0,
        'SHELL_ASSETS 項目不含 ?v= 快取破壞參數'
      );
      assert.ok(
        rawItems.every(item => !item.includes('?v=')),
        '確認 SHELL_ASSETS 內所有項目皆不含 ?v='
      );
    }
  });

  test('SHELL_ASSETS 核心預快取清單完整性（檔案皆存在於磁碟）', () => {
    // 擷取 SHELL_ASSETS 陣列
    const assetsMatch = swContent.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(assetsMatch, 'sw.js 應包含 SHELL_ASSETS 定義');

    const rawItems = assetsMatch[1]
      .split('\n')
      .map(line => line.trim().replace(/^['"]|['"],?$/g, ''))
      .filter(item => item && !item.startsWith('//'));

    assert.ok(rawItems.length >= 10, 'SHELL_ASSETS 至少應包含 10 個核心靜態資源');

    for (const item of rawItems) {
      if (item === '/' || item === '/manifest.json') {
        continue; // 虛擬首頁路由或動態 SSR manifest
      }
      const diskPath = path.join(ROOT_DIR, item.startsWith('/') ? item.slice(1) : item);
      assert.ok(
        fs.existsSync(diskPath),
        `SHELL_ASSETS 指定的資源 "${item}" 必須實體存在於磁碟 (${diskPath})`
      );
    }
  });

  test('activate 僅刪除舊版 mdwebview 自有快取，不刪除同源其他應用快取', () => {
    assert.ok(swContent.includes("key.startsWith('mdwebview-shell-')"), '應將清理範圍限制於 mdwebview shell cache');
    assert.ok(swContent.includes("key.startsWith('mdwebview-content-')"), '應將清理範圍限制於 mdwebview content cache');
    assert.ok(swContent.includes('isMdWebviewCache && key !== SHELL_CACHE && key !== CONTENT_CACHE'), '應保留目前版本快取及所有非 mdwebview 快取');
  });

  test('caches.match 必須包含 ignoreSearch: true 避免 query parameter 導致離線白屏', () => {
    // 檢查 sw.js 是否在靜態資源與導覽快取比對中啟用 ignoreSearch: true
    const ignoreSearchMatches = swContent.match(/ignoreSearch:\s*true/g);
    assert.ok(
      ignoreSearchMatches && ignoreSearchMatches.length >= 2,
      'sw.js 必須在導覽與靜態資源 caches.match 中啟用 ignoreSearch: true'
    );
  });

  test('manifest.json 格式正確且所引用的圖示檔案皆存在', () => {
    const manifestPath = path.join(ROOT_DIR, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json 檔案應存在');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.name, 'manifest 應有 name');
    assert.ok(manifest.short_name, 'manifest 應有 short_name');
    assert.ok(manifest.start_url, 'manifest 應有 start_url');
    assert.equal(manifest.display, 'standalone', 'display 模式應為 standalone');
    assert.ok(manifest.icons && Array.isArray(manifest.icons), 'manifest 應定義 icons 陣列');

    for (const icon of manifest.icons) {
      assert.ok(icon.src, '每個 icon 必須有 src');
      const iconPath = path.join(ROOT_DIR, icon.src.startsWith('/') ? icon.src.slice(1) : icon.src);
      assert.ok(fs.existsSync(iconPath), `manifest icon "${icon.src}" 必須實體存在於磁碟`);
    }
  });

  test('分層快取策略架構驗證 (Tiered Caching)', () => {
    // 1. 動態 API 不應進入靜態資源快取
    assert.ok(
      swContent.includes("url.pathname.startsWith('/api/')"),
      '應檢查 /api/ 動態請求'
    );
    assert.ok(
      swContent.includes('CONTENT_PATHS.includes(url.pathname)'),
      '僅 CONTENT_PATHS 列出的 API 可快取，其餘應走 Network-Only'
    );

    // 2. 導覽請求回退至離線 App Shell
    assert.ok(
      swContent.includes("req.mode === 'navigate'"),
      '應處理 navigate 模式以支援離線啟動'
    );

    // 3. 離線未快取經文之 503 JSON 回應
    assert.ok(
      swContent.includes('目前處於離線狀態，此經文尚未快取'),
      '未快取經文離線時應回傳清楚的 503 提示訊息'
    );
  });

  /**
   * 這裡曾有一個真實的離線功能缺失：可快取清單寫的是 `/api/file`，
   * 但前端從來不呼叫它（實際讀取經文走 `/api/render`）。
   * 結果「看過的經文斷網後仍可重看」實際上從未成立。
   * 因此改為逐一驗證 CONTENT_PATHS 的每個項目都真的是 server.js 的路由。
   */
  test('CONTENT_PATHS 每個端點都必須是 server.js 真實存在的路由', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    const paths = parseContentPaths(swContent);

    assert.ok(paths.length >= 2, `CONTENT_PATHS 應至少列出 2 個端點，實際 ${paths.length}`);

    for (const p of paths) {
      assert.ok(
        serverSrc.includes(`pathname === '${p}'`),
        `CONTENT_PATHS 的 "${p}" 在 server.js 中找不到對應路由（應為 pathname === '${p}'）`
      );
    }

    // 前端真正用來讀取經文的端點必須在清單內，否則離線閱讀形同無效。
    const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');
    const readerEndpoints = ['/api/render'];
    for (const ep of readerEndpoints) {
      assert.ok(
        appSrc.includes(ep),
        `app.js 應使用 ${ep} 讀取內容（本測試的前提）`
      );
      assert.ok(
        paths.includes(ep),
        `${ep} 是前端讀取經文用的端點，必須列入 CONTENT_PATHS 才能離線閱讀`
      );
    }
  });

  test('快取鍵必須忽略 line 參數但保留 path/from/to', () => {
    // `/api/render` 的 line 只是前端捲動提示，伺服器完全不讀取
    // （handleRender 只使用 query.path）；若納入快取鍵，
    // 同一份經文會依捲動位置重複佔用快取。
    assert.ok(
      /IGNORED_QUERY_PARAMS\s*=\s*\[[^\]]*'line'/.test(swContent),
      'IGNORED_QUERY_PARAMS 應包含 line'
    );
    assert.ok(
      swContent.includes("url.searchParams.delete(name)"),
      'contentCacheKey 應實際刪除被忽略的參數'
    );

    // 必須保留具識別性的參數，否則不同經文／分段會互相覆蓋。
    for (const keep of ['path', 'from', 'to']) {
      assert.ok(
        !new RegExp(`IGNORED_QUERY_PARAMS\\s*=\\s*\\[[^\\]]*'${keep}'`).test(swContent),
        `不得忽略 "${keep}"，否則不同內容會共用同一筆快取`
      );
    }
  });

  test('contentCacheKey 必須保留原請求標頭（回應帶 Vary: Accept-Encoding）', () => {
    // server.js 的 /api/render 回應帶 `Vary: Accept-Encoding`，
    // Cache Storage 會依儲存請求的標頭比對；若用
    // `new Request(url, { method: 'GET' })` 之類的作法丟掉標頭，
    // 可能寫得進去卻比對不到。
    assert.ok(
      swContent.includes('new Request(url.toString(), req)'),
      'contentCacheKey 應以原請求作為 init 以保留標頭'
    );

    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.ok(
      serverSrc.includes("'Vary': 'Accept-Encoding'") || serverSrc.includes('Vary'),
      '前提：/api/render 回應帶 Vary，故快取鍵必須保留標頭'
    );
  });

  test('僅快取 200 且為 GET 的回應', () => {
    assert.ok(
      /networkRes\.status === 200 && req\.method === 'GET'/.test(swContent),
      '內容快取應同時檢查 status 200 與 GET，避免存入 206/錯誤回應'
    );
  });

  test('index.html 與 app.js 包含完整 PWA 支援與 Service Worker 註冊', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'app.js'), 'utf8');

    // index.html 應包含 PWA 必要標頭
    assert.ok(indexHtml.includes('manifest.json'), 'index.html 應包含 manifest.json 連結');
    assert.ok(indexHtml.includes('theme-color'), 'index.html 應定義 theme-color meta');
    assert.ok(indexHtml.includes('apple-touch-icon'), 'index.html 應定義 apple-touch-icon');
    assert.ok(indexHtml.includes('app.js'), 'index.html 應引入 app.js');

    // app.js 應註冊 sw.js 並監聽離線狀態
    assert.ok(
      appJs.includes("navigator.serviceWorker.register('/sw.js')"),
      'app.js 應註冊 /sw.js'
    );
    assert.ok(
      appJs.includes("window.addEventListener('offline'"),
      'app.js 應監聽 offline 事件以提供離線提示'
    );
  });
});
