const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const {
  server,
  getSectionIndex,
  computeChunkRanges,
  terminateWorkerPools,
  resetTreeWatcher,
  resetDictWatcher,
  resetConfigWatcher
} = require('../server.js');

let baseUrl = '';

function request(reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const reqOptions = {
      agent: false,
      ...options,
      headers: {
        Connection: 'close',
        ...(options.headers || {})
      }
    };
    const req = http.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            buffer = zlib.gunzipSync(buffer);
          } catch (e) {
            return reject(e);
          }
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer.toString('utf-8')
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('SSR 與大型檔案動態分塊渲染 (SSR & Large File Chunked API)', () => {
  const LARGE_FILE_REL = '01-大正藏/14瑜伽部類/T1579《瑜伽師地論》.md';
  const SMALL_FILE_REL = '01-大正藏/03般若部類/T0251《般若波羅蜜多心經》.md';
  const DICT_FILE_REL = 'dict:南山律學辭典.md';

  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof resetTreeWatcher === 'function') resetTreeWatcher();
    if (typeof resetDictWatcher === 'function') resetDictWatcher();
    if (typeof resetConfigWatcher === 'function') resetConfigWatcher();
    if (typeof terminateWorkerPools === 'function') {
      await terminateWorkerPools();
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Crawler SSR 伺服器端預渲染測試
  // ─────────────────────────────────────────────────────────────
  describe('1. 爬蟲與 SEO SSR 動態預渲染 (Crawler SSR)', () => {
    test('GET /?ssr=1 首頁總覽 SSR 模式', async () => {
      const res = await request('/?ssr=1');
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      // 應包含 Sitemap 連結與導覽清單
      assert.ok(res.body.includes('sitemap.xml'), '首頁 SSR 應包含 sitemap.xml 連結');
      assert.ok(res.body.includes('welcome-screen" id="welcomeScreen" style="display:none"'), '應隱藏歡迎畫面');
      assert.ok(res.body.includes('content-wrapper" id="contentWrapper" style="display:block"'), '應展開內容容器');
      // CSP nonce 應正確注入
      assert.ok(res.headers['content-security-policy'].includes('nonce-'), '應具備動態 CSP nonce');
    });

    test('GET /?file=...&ssr=1 經文文件 SSR 動態注入完整 SEO 標籤與正文', async () => {
      const res = await request(`/?file=${encodeURIComponent(SMALL_FILE_REL)}&ssr=1`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));

      // 1. 標題與 OpenGraph / Twitter Card 標籤
      assert.ok(res.body.includes('<title>T0251《般若波羅蜜多心經》'), '標題應替換為經文名稱');
      assert.ok(res.body.includes('<meta property="og:title"'), '應包含 og:title');
      assert.ok(res.body.includes('<meta property="og:type" content="article">'), '應設定 og:type 為 article');
      assert.ok(res.body.includes('<meta name="twitter:title"'), '應包含 twitter:title');

      // 2. 結構化資料 (Schema.org Article & BreadcrumbList)
      assert.ok(res.body.includes('application/ld+json'), '應包含 JSON-LD 結構化資料');
      assert.ok(res.body.includes('"@type":"Article"'), 'JSON-LD 應包含 Article 定義');
      assert.ok(res.body.includes('"@type":"BreadcrumbList"'), 'JSON-LD 應包含 BreadcrumbList 麵包屑');

      // 3. 正文 HTML 注入 (不可為空白)
      assert.ok(res.body.includes('class="markdown-body" id="markdownBody"'), '應有 markdownBody');
      assert.ok(res.body.includes('觀自在菩薩') || res.body.includes('舍利子'), 'SSR 正文應包含經文內容');
      assert.ok(res.body.includes('class="line-anchor"'), '正文應注入行號錨點');
    });

    test('User-Agent 爬蟲識別自動啟用 SSR（無須手動加 &ssr=1）', async () => {
      const res = await request(`/?file=${encodeURIComponent(SMALL_FILE_REL)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('<meta property="og:title"'), 'Googlebot 應自動觸發 SSR 模式');
      assert.ok(res.body.includes('application/ld+json'), 'Googlebot 應獲得 JSON-LD 結構化資料');
      assert.ok(res.body.includes('觀自在菩薩') || res.body.includes('舍利子'), 'Googlebot 應直接取得預渲染正文');
    });

    test('SSR 安全防禦：不存在檔案回傳 404，路徑穿越回傳 403', async () => {
      // 404 不存在
      const res404 = await request('/?file=not-exist-sutra-999.md&ssr=1');
      assert.equal(res404.statusCode, 404);

      // 403 路徑穿越
      const res403 = await request('/?file=../../server.js&ssr=1');
      assert.equal(res403.statusCode, 403);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. 標準 Markdown 文件渲染 API (GET /api/render)
  // ─────────────────────────────────────────────────────────────
  describe('2. Markdown 文件渲染 API (GET /api/render)', () => {
    test('標準渲染小檔案並提取 Frontmatter (X-Document-Meta)', async () => {
      const res = await request(`/api/render?path=${encodeURIComponent(SMALL_FILE_REL)}`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.headers['x-document-meta'] !== undefined, '應具備 X-Document-Meta 標頭');
      assert.ok(res.headers['etag'], '應具備 ETag 快取標頭');

      // 驗證解析後的 HTML
      assert.ok(res.body.includes('class="line-anchor"'), '應包含行號錨點標籤');
      assert.ok(res.body.includes('id="L1"') || res.body.includes('data-line="1"'), '首行應有 L1 行號錨點');
    });

    test('支援 ETag 與 If-None-Match 回傳 304 Not Modified', async () => {
      const resInitial = await request(`/api/render?path=${encodeURIComponent(SMALL_FILE_REL)}`);
      const etag = resInitial.headers['etag'];
      assert.ok(etag, '必須有 ETag');

      const resCached = await request(`/api/render?path=${encodeURIComponent(SMALL_FILE_REL)}`, {
        headers: { 'If-None-Match': etag }
      });
      assert.equal(resCached.statusCode, 304, 'ETag 相符時應回傳 304');
      assert.equal(resCached.body, '', '304 回應主體應為空');
    });

    test('支援 Gzip 壓縮內容協商 (Accept-Encoding: gzip)', async () => {
      const res = await request(`/api/render?path=${encodeURIComponent(SMALL_FILE_REL)}`, {
        headers: { 'Accept-Encoding': 'gzip' }
      });
      assert.equal(res.statusCode, 200);
      // request 函式內部會自動解壓縮，驗證解壓縮後內容完整性
      assert.ok(res.body.includes('class="line-anchor"'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. 大型檔案章節索引引擎 (GET /api/section-index)
  // ─────────────────────────────────────────────────────────────
  describe('3. 大型檔案章節索引引擎 (GET /api/section-index)', () => {
    test('小型檔案 (< 1MB) 回傳 { large: false }', async () => {
      const res = await request(`/api/section-index?path=${encodeURIComponent(SMALL_FILE_REL)}`);
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.large, false, '小於 1MB 的檔案 large 屬性應為 false');
    });

    test('大型經文 (>= 1MB, 如《瑜伽師地論》) 建立章節索引與分塊邊界', async () => {
      const res = await request(`/api/section-index?path=${encodeURIComponent(LARGE_FILE_REL)}`);
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);

      assert.equal(data.large, true, '大型檔案 large 屬性應為 true');
      assert.ok(data.totalLines > 1000, '總行數應超過 1000 行');
      assert.ok(Array.isArray(data.entries), '應回傳 entries 陣列');
      assert.ok(data.entries.length > 0, '章節 entries 不得為空');

      // 驗證 entry 結構：{ h: headword, ls: lineStart, le: lineEnd, level }
      const firstEntry = data.entries[0];
      assert.ok(firstEntry.h, 'Entry 應具備 headword 標題');
      assert.ok(typeof firstEntry.ls === 'number' && firstEntry.ls >= 1, 'Entry 應有有效 lineStart');
      assert.ok(typeof firstEntry.le === 'number', 'Entry 應有有效 lineEnd');

      // 驗證 chunks 邊界計算
      assert.ok(Array.isArray(data.chunks), '應回傳 chunks 預算分塊邊界');
      assert.ok(data.chunks.length > 0, 'chunks 陣列不應為空');
      const firstChunk = data.chunks[0];
      assert.equal(firstChunk.from, 0, '第一個分塊 from 應為 0');
      assert.ok(firstChunk.to >= firstChunk.from, '分塊 to 應大於等於 from');
      assert.equal(firstChunk.lineStart, 1, '第一個分塊 lineStart 應為 1');

      // 驗證分塊連續性 (連續無空隙)
      for (let i = 1; i < data.chunks.length; i++) {
        assert.equal(data.chunks[i].from, data.chunks[i - 1].to + 1, `Chunk #${i} 的 from 應銜接前一個 chunk 的 to + 1`);
      }
    });

    test('大型佛學辭典多根目錄索引 (dict: 前綴支援)', async () => {
      const res = await request(`/api/section-index?path=${encodeURIComponent(DICT_FILE_REL)}`);
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);

      assert.equal(data.large, true, '大型辭典檔案應標記為 large: true');
      assert.equal(data.file, DICT_FILE_REL, '回傳 file 應保留 dict: 前綴');
      assert.ok(data.entries.length >= 100, '大型辭典條目應超過 100 條');
      assert.ok(data.chunks.length > 0, '應包含計算好的分塊區間');
    });

    test('Section Index 支援 ETag 與 304 快速協商', async () => {
      const res1 = await request(`/api/section-index?path=${encodeURIComponent(LARGE_FILE_REL)}`);
      const etag = res1.headers['etag'];
      assert.ok(etag, 'Section index 應回傳 ETag');

      const res2 = await request(`/api/section-index?path=${encodeURIComponent(LARGE_FILE_REL)}`, {
        headers: { 'If-None-Match': etag }
      });
      assert.equal(res2.statusCode, 304, '相同 ETag 應回傳 304 Not Modified');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. 大型檔案分塊動態渲染 API (GET /api/render-chunk)
  // ─────────────────────────────────────────────────────────────
  describe('4. 大型檔案分塊動態渲染 API (GET /api/render-chunk)', () => {
    test('動態渲染大型經文首塊 (from=0, to=5)', async () => {
      const res = await request(`/api/render-chunk?path=${encodeURIComponent(LARGE_FILE_REL)}&from=0&to=5`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));

      // 驗證 X-Chunk-Meta Base64 標頭
      const metaHeader = res.headers['x-chunk-meta'];
      assert.ok(metaHeader, '應回傳 X-Chunk-Meta 標頭');
      const meta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf-8'));
      assert.equal(meta.from, 0);
      assert.ok(meta.to >= 0 && meta.to <= 5);
      assert.equal(meta.lineStart, 1, '首個分塊行號起始應為 1');
      assert.ok(meta.totalEntries > 0, '應包含總條目數');

      // 驗證渲染出的 HTML
      assert.ok(res.body.includes('class="line-anchor"'), '應包含行號錨點');
      assert.ok(res.body.includes('id="L1"') || res.body.includes('data-line="1"'), '首個分塊應包含 L1 行號錨點');
    });

    test('動態渲染大型經文深層分塊 (from=10, to=15) 保持行號錨點精確對齊', async () => {
      const res = await request(`/api/render-chunk?path=${encodeURIComponent(LARGE_FILE_REL)}&from=10&to=15`);
      assert.equal(res.statusCode, 200);

      const meta = JSON.parse(Buffer.from(res.headers['x-chunk-meta'], 'base64').toString('utf-8'));
      assert.equal(meta.from, 10);
      assert.ok(meta.lineStart > 1, `深層分塊的 lineStart 必須大於 1 (實際: ${meta.lineStart})`);

      // 驗證深層分塊中的行號錨點不是從 1 開始，而是與 lineStart 一致
      const expectedAnchor = `id="L${meta.lineStart}"`;
      const expectedDataLine = `data-line="${meta.lineStart}"`;
      assert.ok(
        res.body.includes(expectedAnchor) || res.body.includes(expectedDataLine),
        `HTML 錨點中應包含與 lineStart 對齊的行號標籤 ${expectedAnchor}`
      );
    });

    test('大型辭典分塊動態渲染 (dict: 前綴路徑)', async () => {
      const res = await request(`/api/render-chunk?path=${encodeURIComponent(DICT_FILE_REL)}&from=0&to=3`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['x-chunk-meta'], '辭典分塊渲染應具備 X-Chunk-Meta');
      assert.ok(res.body.includes('class="line-anchor"'), '辭典內容應注入行號錨點');
    });

    test('分塊渲染參數防禦 (無效 from/to 回傳 400)', async () => {
      // 缺少或非法數值
      const res1 = await request(`/api/render-chunk?path=${encodeURIComponent(LARGE_FILE_REL)}&from=abc&to=5`);
      assert.equal(res1.statusCode, 400);

      // from > to
      const res2 = await request(`/api/render-chunk?path=${encodeURIComponent(LARGE_FILE_REL)}&from=10&to=5`);
      assert.equal(res2.statusCode, 400);

      // 負數
      const res3 = await request(`/api/render-chunk?path=${encodeURIComponent(LARGE_FILE_REL)}&from=-1&to=5`);
      assert.equal(res3.statusCode, 400);
    });

    test('小型檔案請求 render-chunk 自動平滑降級為完整渲染', async () => {
      const res = await request(`/api/render-chunk?path=${encodeURIComponent(SMALL_FILE_REL)}&from=0&to=5`);
      assert.equal(res.statusCode, 200);
      // 小型檔案降級走 handleRender，具備 X-Document-Meta 而非 X-Chunk-Meta
      assert.ok(res.headers['x-document-meta'] !== undefined);
      assert.ok(res.body.includes('觀自在菩薩') || res.body.includes('舍利子'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. 底層演算法單元驗證 (Section Index Engine)
  // ─────────────────────────────────────────────────────────────
  describe('5. 底層演算法單元驗證 (getSectionIndex & computeChunkRanges)', () => {
    test('computeChunkRanges 單元計算測試', () => {
      // 構造假 Section Index 物件
      const mockIdx = {
        entries: Array.from({ length: 250 }, (_, i) => ({
          headword: `條目 ${i + 1}`,
          offset: i * 500,
          len: 500,
          lineStart: i * 10 + 1
        }))
      };

      const ranges = computeChunkRanges(mockIdx);
      assert.ok(Array.isArray(ranges));
      assert.ok(ranges.length >= 3, '250 個條目應分成至少 3 個 chunks (預設 CHUNK_ENTRIES=100)');
      assert.equal(ranges[0].from, 0);
      assert.equal(ranges[0].to, 99);
      assert.equal(ranges[1].from, 100);
      assert.equal(ranges[1].to, 199);
      assert.equal(ranges[2].from, 200);
      assert.equal(ranges[2].to, 249);
    });
  });
});
