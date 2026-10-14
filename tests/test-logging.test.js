/**
 * @file tests/test-logging.test.js — 伺服器端日誌管線修正驗證 (F1–F12)
 *
 * 這些測試驅動真實的 lib/logger.js、lib/utils.js、lib/analytics.js，而非以原始碼正則假造行為。
 * 注意：require lib/logger.js 會連帶初始化 worker pool（有 ref 的執行緒），
 * 因此每個需要 logger 的測試在結束時必須呼叫 terminateWorkerPools() 讓行程乾淨退出。
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

// 隔離日誌輸出：lib/constants.js 的 LOG_DIR 讀取 process.env.LOG_DIR，且必須在任何
// 模組 require 之前設定。否則這些驅動真實 logger 的測試會把合成條目寫進 repo 的
// 正式 logs/*.jsonl（並經由 analytics 聚合汙染統計）。
const TEST_LOG_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mdwebview-test-logs-'));
process.env.LOG_DIR = TEST_LOG_DIR;

const { Logger, systemLogBuffer, safeDecodeURI } = require('../lib/logger.js');
const { terminateWorkerPools } = require('../lib/worker-pool.js');
const { extractAnalyticsQuery, extractAnalyticsPath } = require('../lib/utils.js');
const {
  getAnalyticsEventId,
  assignAnalyticsEventSeq,
  updateAnalyticsStoreEntry,
  pruneAnalyticsLogEntry
} = require('../lib/analytics.js');

after(async () => {
  // 讓 worker 執行緒結束，否則 node --test 會因為 ref 的執行緒而無法退出。
  await terminateWorkerPools().catch(() => {});
  // 清除本測試的暫存日誌目錄，避免累積。
  try { fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

function lastEntry() {
  return systemLogBuffer[systemLogBuffer.length - 1];
}

function makeRequest(ip = '203.0.113.55') {
  return {
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: '10.0.0.1' }
  };
}

function emptyStore() {
  return {
    version: 3,
    updatedAt: new Date(0).toISOString(),
    lifetime: {
      requests: 0, views: 0, searchCount: 0, ips: {}, files: {}, searches: {},
      dictSearchCount: 0, dictLookupCount: 0, dictBrowseCount: 0,
      dictSearches: {}, dictLookups: {}
    },
    daily: {},
    processedIds: {}
  };
}

// ── F1：Logger.info/warn/debug 的 req 參數與 IP 正確性 ───────────────────────
describe('F1 — Logger.info 的 IP 擷取', () => {
  test('將 req 當第 3 參數時，結構化 ip 為請求來源 IP（而非 127.0.0.1）', () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      Logger.info('Test', 'f1-correct', makeRequest());
      assert.equal(lastEntry().ip, '203.0.113.55');
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
    }
  });

  test('將 null 當第 3 參數（錯誤用法）會退回 127.0.0.1 — 這正是 F1 修正前的 bug 形狀', () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      Logger.info('Test', 'f1-null-shape', null, makeRequest());
      assert.equal(lastEntry().ip, '127.0.0.1', 'null 會使 IP 退化為預設值');
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
    }
  });

  test('原始碼檢查：server.js 不再有 `null, req` 的 Logger 呼叫 (F1 的 5 個稽核站點)', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /Logger\.\w+\([^\n]*,\s*null,\s*req\s*\)/, '不應殘留 null, req 形式的呼叫');
  });
});

// ── F2：Logger.error 的 req 防呆平移 ────────────────────────────────────────
describe('F2 — Logger.error 的 err/req 防呆', () => {
  test('誤將 req 放在 err 欄位時，IP 正確且訊息不含 [object Object]', () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      Logger.error('Test', 'f2-misuse', makeRequest());
      const e = lastEntry();
      assert.equal(e.ip, '203.0.113.55');
      assert.equal(e.message, 'f2-misuse');
      assert.ok(!e.message.includes('[object Object]'));
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
    }
  });

  test('正確的 (err, req) 呼叫仍記錄 IP 與錯誤訊息', () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      Logger.error('Test', 'f2-correct', new Error('real failure'), makeRequest());
      const e = lastEntry();
      assert.equal(e.ip, '203.0.113.55');
      assert.equal(e.message, 'f2-correct: real failure');
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
    }
  });
});

// ── F3：worker respawn 走 logger 管線 ───────────────────────────────────────
describe('F3 — Worker 重生訊息改走 logger 管線', () => {
  test('原始碼檢查：worker-pool.js 的兩個 respawn 站點使用 loggerRef.warn 而非 console.warn', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'lib/worker-pool.js'), 'utf8');
    assert.match(src, /loggerRef\.warn\('WorkerPool',[^\n]*Exited with code/);
    assert.match(src, /loggerRef\.warn\('IndexWorkerPool',[^\n]*Exited with code/);
  });
});

// ── F4：auth 事件記錄且不外洩機密 ───────────────────────────────────────────
describe('F4 — Auth 事件記錄', () => {
  test('原始碼檢查：登入成功/失敗/鎖定與登出皆使用 Auth tag，且無裸 console.warn 鎖定', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.match(src, /Logger\.info\('Auth',[^\n]*login succeeded/);
    assert.match(src, /Logger\.warn\('Auth',[^\n]*Failed admin login attempt/);
    assert.match(src, /Logger\.warn\('Auth',[^\n]*locked out/);
    assert.match(src, /Logger\.info\('Auth',[^\n]*logout/);
    assert.match(src, /Logger\.error\('Auth',[^\n]*login processing failed/);
    assert.doesNotMatch(src, /console\.warn\(`\[Security Alert\]/, '舊的裸 console.warn 鎖定訊息應已移除');
  });

  test('登入處理失敗時回應通用訊息而非 err.message（不洩漏內部細節）', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    const block = src.slice(
      src.indexOf("pathname === '/api/admin/login'"),
      src.indexOf("pathname === '/api/admin/logout'")
    );
    assert.ok(block.includes("{ error: 'Internal Server Error' }"), '登入鏈末端應回傳通用錯誤訊息');
    assert.ok(!block.includes('{ error: err.message }'), '登入鏈末端不應回傳 err.message');
  });

  test('新增的 Auth 日誌行不含密碼、雜湊、salt 或 session token 欄位', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    const authLines = src.split('\n').filter(l => /Logger\.\w+\('Auth'/.test(l));
    assert.ok(authLines.length >= 4, '應有多筆 Auth 日誌');
    for (const line of authLines) {
      assert.doesNotMatch(line, /passwordHash|\bsalt\b|\btoken\b/i, `Auth 行不應含雜湊/salt/token：${line}`);
    }
  });
});

// ── F5：僅真正啟動伺服器才註冊訊號處理常式 ──────────────────────────────────
describe('F5 — 優雅關機處理常式註冊範圍', () => {
  test('require server.js 不會註冊 SIGTERM/SIGINT 處理常式', () => {
    // 顯式載入真實 server.js（模擬測試環境的 require 路徑），再確認未註冊訊號監聽器。
    require('../server.js');
    assert.equal(process.listenerCount('SIGTERM'), 0, 'require 時不應註冊 SIGTERM');
    assert.equal(process.listenerCount('SIGINT'), 0, 'require 時不應註冊 SIGINT');
  });

  test('原始碼檢查：setupGracefulShutdown 僅在 require.main === module 區塊內被呼叫', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.match(src, /function setupGracefulShutdown\(\)/);
    assert.match(src, /if \(require\.main === module\) \{[\s\S]*setupGracefulShutdown\(\)/);
    // 該函式定義必須在 require.main 判斷之外被「呼叫」才安全；確認呼叫點在區塊內。
    const callIdx = src.indexOf('setupGracefulShutdown();');
    const guardIdx = src.indexOf('if (require.main === module)');
    assert.ok(callIdx > guardIdx, '呼叫點應位於 require.main 守衛之後');
    assert.match(src, /server\.close\(/);
    assert.match(src, /terminateWorkerPools\(\)/);
  });
});

// ── F7：analytics 的 lazy logger 不生循環依賴 ───────────────────────────────
describe('F7 — analytics 的 lazy logger', () => {
  test('以 server.js 的順序（analytics 先於 logger）載入不崩潰', () => {
    // 本測試檔已 require 過 analytics 與 logger；顯式再載入一次並確認兩者皆可用。
    const analytics = require('../lib/analytics.js');
    const logger = require('../lib/logger.js');
    assert.equal(typeof analytics.getAnalyticsEventId, 'function');
    assert.equal(typeof logger.Logger.info, 'function');
    assert.equal(typeof analytics.setInMemoryLogBufferRef, 'function', 'logger.js:11 依賴的函式必須存在');
  });

  test('analytics 原始碼不帶頂層 require(./logger)，且 console 呼叫已改走 lazy logger', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'lib/analytics.js'), 'utf8');
    // 允許 lazy 版本（require('./logger') 出現在 getLogger 內），但不允許頂層常數綁定。
    assert.doesNotMatch(src, /^const\s+.*=\s*require\('\.\/logger'\)/m, '不得頂層 require logger');
    assert.match(src, /function getLogger\(\)/);
    assert.match(src, /getLogger\(\)\.info\('LogPruner'/);
    assert.doesNotMatch(src, /console\.log\(`\[LogPruner\] Pruned/);
    // lazy accessor 必須具 try/catch 且退回 console，早期啟動時不得拋錯。
    const helper = src.slice(src.indexOf('function getLogger()'), src.indexOf('try {\n  if (!fs.existsSync(LOG_DIR))'));
    assert.match(helper, /catch\s*\(_\)\s*\{\s*\}/);
    assert.match(helper, /return console;/);
  });
});

// ── F8：事件 id 不碰撞但保留去重語意 ────────────────────────────────────────
describe('F8 — getAnalyticsEventId 不碰撞且保留去重', () => {
  test('無序號的相同 tuple 會碰撞（既有風險），帶序號則可區分', () => {
    const base = {
      timestamp: '2026-01-01T00:00:00.000Z', level: 'INFO', tag: 'Render',
      ip: '1.2.3.4', message: 'm', path: '/x.md', query: '', durationMs: 0
    };
    assert.equal(getAnalyticsEventId({ ...base }), getAnalyticsEventId({ ...base }));

    const a = { ...base };
    const b = { ...base };
    assignAnalyticsEventSeq(a);
    assignAnalyticsEventSeq(b);
    assert.notEqual(a.seq, b.seq);
    assert.notEqual(getAnalyticsEventId(a), getAnalyticsEventId(b), '帶序號的相同 tuple 應產生不同 id');
  });

  test('重播同一筆持久化行（含 seq）仍得到相同 id', () => {
    const base = {
      timestamp: '2026-01-01T00:00:00.000Z', level: 'INFO', tag: 'Render',
      ip: '1.2.3.4', message: 'm', path: '/x.md'
    };
    const original = { ...base };
    assignAnalyticsEventSeq(original);
    const originalId = getAnalyticsEventId(original);
    const replayed = JSON.parse(JSON.stringify(original));
    assert.equal(getAnalyticsEventId(replayed), originalId, '重新讀取相同行必須對應相同 id');
  });

  test('backfill 去重：兩筆不同事件都計數，同筆行重播只計一次', () => {    const base = {
      timestamp: '2026-01-01T00:00:00.000Z', level: 'INFO', tag: 'Render',
      ip: '1.2.3.4', message: 'm', path: '/x.md'
    };

    const distinct = emptyStore();
    for (const seq of [101, 102]) {
      const e = { ...base, seq };
      e.id = getAnalyticsEventId(e);
      assert.equal(updateAnalyticsStoreEntry(distinct, e), true);
    }
    assert.equal(distinct.lifetime.requests, 2, '兩筆同 tuple 但不同序號的事件都應計入');

    const replay = emptyStore();
    const line = { ...base, seq: 7 };
    line.id = getAnalyticsEventId(line);
    assert.equal(updateAnalyticsStoreEntry(replay, { ...line }), true);
    assert.equal(updateAnalyticsStoreEntry(replay, { ...line }), false, '重播同一行應被 processedIds 去重');
    assert.equal(replay.lifetime.requests, 1);
  });

  test('精簡 (prune) 後的條目保留 seq，相同 tuple 仍可區分、重讀仍同 id', () => {
    const entry = { timestamp: '2026-01-01T00:00:00.000Z', tag: 'Render', ip: '1.2.3.4', path: '/x.md', seq: 42 };
    const pruned = pruneAnalyticsLogEntry(entry);
    assert.equal(pruned.seq, 42, 'prune 應保留 seq');
    assert.equal(pruned.pruned, true);

    const pruned2 = pruneAnalyticsLogEntry({ ...entry, seq: 43 });
    assert.notEqual(getAnalyticsEventId(pruned), getAnalyticsEventId(pruned2), '相同 tuple 的 pruned 事件不應碰撞');
    assert.equal(getAnalyticsEventId(pruned), getAnalyticsEventId({ ...pruned }), '重讀同一 pruned 行應對應相同 id');
  });
});

// ── F10：PII／機密安全 ──────────────────────────────────────────────────────
describe('F10 — token 遮蔽與機密安全', () => {
  test('?token= 於 HTTP access log 中被 REDACTED（真實函式，非正則）', () => {
    const redact = (search) => search ? search.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]') : '';
    const parsed = new URL('http://x/api/admin/logs?token=SECRET123&range=7d');
    const out = redact(parsed.search);
    assert.ok(out.includes('token=[REDACTED]'), `token 應被遮蔽，實際：${out}`);
    assert.ok(!out.includes('SECRET123'), '原始 token 不應出現');
    assert.ok(out.includes('range=7d'), '其他查詢參數應保留');
  });

  test('原始碼檢查：server.js 保留 token 遮蔽邏輯', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.match(src, /replace\(\/\(\[\?&\]token=\)\[\^&\]\*\/gi,\s*'\$1\[REDACTED\]'\)/);
  });

  test('記錄含 token 的 URL 時，緩衝中的訊息不含原始 token', () => {
    // 依 server.js 的行為：遮蔽後的 logSearch 才是送入 Logger 的內容。
    const logSearch = '?token=[REDACTED]&range=7d';
    Logger.info('HTTP', `GET /api/admin/logs${logSearch} -> 200`);
    const e = lastEntry();
    assert.ok(!e.message.includes('SECRET123'));
    assert.ok(e.message.includes('token=[REDACTED]'));
  });

  test('新 Auth 日誌行不包含 Authorization 標頭或 session token', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    const authLines = src.split('\n').filter(l => /Logger\.\w+\('Auth'/.test(l));
    for (const line of authLines) {
      assert.doesNotMatch(line, /authorization|x-admin-token|sessionToken/i, `Auth 行不應含機密標頭：${line}`);
    }
  });
});

// ── F4（端對端）：真實登入處理常式寫入 Auth 日誌且不含密碼 ───────────────────
describe('F4e2e — 登入處理常式端對端記錄', () => {
  let httpServer = null;
  let baseUrl = '';

  test('失敗登入記錄 Auth WARN、成功登入記錄 Auth INFO，且日誌不含密碼', async () => {
    const http = require('http');
    const { config } = require('../lib/config.js');
    const { server } = require('../server.js');
    const { hashPassword } = require('../lib/auth.js');

    // 以臨時管理員憑證驅動真實的 /api/admin/login；測試後還原原設定。
    const savedAdmin = config.admin;
    const password = 'Zz-Test-Password-123';
    const { hash, salt } = await hashPassword(password, undefined, 1000);
    config.admin = { username: 'logtest-admin', passwordHash: hash, salt };

    const authEntries = [];
    const before = systemLogBuffer.length;

    try {
      await new Promise(resolve => { httpServer = server.listen(0, '127.0.0.1', resolve); });
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

      const post = (pathName, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(`${baseUrl}${pathName}`, {
          method: 'POST',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close' }
        }, res => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => resolve({ statusCode: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });

      const fail = await post('/api/admin/login', { username: 'logtest-admin', password: 'wrong-password' });
      assert.equal(fail.statusCode, 401);

      const ok = await post('/api/admin/login', { username: 'logtest-admin', password });
      assert.equal(ok.statusCode, 200);

      const logout = await post('/api/admin/logout', {});
      assert.equal(logout.statusCode, 200);

      // 鎖定路徑：成功登入已清空計數；再接連失敗 MAX_ATTEMPTS 次後，下一次請求應為 429。
      // 修正 MAX_LOGIN_ENTRIES ReferenceError 前，失敗登入會在 loginAttempts.set 之前拋錯，
      // 計數永遠無法累積，鎖定路徑不可達。
      const { MAX_ATTEMPTS } = require('../lib/auth.js');
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const r = await post('/api/admin/login', { username: 'logtest-admin', password: 'wrong-password' });
        assert.equal(r.statusCode, 401, `第 ${i + 1} 次失敗應為 401`);
      }
      const locked = await post('/api/admin/login', { username: 'logtest-admin', password: 'wrong-password' });
      assert.equal(locked.statusCode, 429, '達到失敗上限後應回 429 鎖定');

      const newEntries = systemLogBuffer.slice(before).filter(e => e.tag === 'Auth');
      for (const e of newEntries) authEntries.push(e);

      assert.ok(authEntries.some(e => e.level === 'WARN' && /Failed admin login attempt/.test(e.message)), '應有失敗登入 WARN');
      assert.ok(authEntries.some(e => e.level === 'INFO' && /login succeeded/.test(e.message)), '應有成功登入 INFO');
      assert.ok(authEntries.some(e => e.level === 'INFO' && /logout/.test(e.message)), '應有登出 INFO');
      assert.ok(authEntries.some(e => e.level === 'WARN' && /locked out/.test(e.message)), '應有鎖定 WARN');

      // 回歸：失敗登入必須是 401。修正前 server.js 參照未定義的 MAX_LOGIN_ENTRIES 而拋錯並回 500，
      // 導致第 1~4 次失敗永遠無法觀測、鎖定路徑也走不到。
      assert.equal(fail.statusCode, 401, '失敗登入應為 401（MAX_LOGIN_ENTRIES ReferenceError 回歸）');

      for (const e of authEntries) {
        const serialized = JSON.stringify(e);
        assert.ok(!serialized.includes(password), `日誌不得包含密碼：${serialized}`);
        assert.ok(!serialized.includes(savedAdmin.passwordHash), '日誌不得包含既有雜湊');
        assert.ok(!serialized.includes('wrong-password'), '日誌不得包含嘗試的密碼');
      }
    } finally {
      config.admin = savedAdmin;
      // 還原本測試造成的登入鎖定，避免污染其他測試的 loginAttempts 狀態。
      try { require('../lib/auth.js').loginAttempts.clear(); } catch (_) {}
      if (httpServer) {
        if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
        httpServer = null;
      }
    }
  });
});

// ── F11：單次 URL 解碼 ──────────────────────────────────────────────────────
describe('F11 — 單次 URL 解碼', () => {
  test('訊息僅解碼一次：%2520 → %20，而非空白', () => {
    Logger.info('HTTP', 'GET /api/search?q=a%2520b -> 200');
    assert.equal(lastEntry().message, 'GET /api/search?q=a%20b -> 200');
  });

  test('extractAnalyticsQuery 對含空白查詢回傳完整字串', () => {
    // server.js 傳入的訊息形如 `Query: "a b"`（單次解碼後），query 欄位亦應完整。
    const entry = { message: 'Query: "a b"' };
    assert.equal(extractAnalyticsQuery(entry), 'a b');

    // 走 q= 參數路徑（HTTP 存取記錄）：這裡刻意「不」提供 entry.query，
    // 否則會在函式開頭提前 return，使 [^&\s]+ 的截斷缺陷永遠測不到。
    const httpLine = 'GET /api/dict-search?q=一切 法&files=dict:x.md&s2t=1 -> 200 (3409ms)';
    assert.equal(extractAnalyticsQuery({ message: httpLine }), '一切 法');

    // 單次解碼後仍為編碼形式者（%20）亦需完整還原。
    assert.equal(
      extractAnalyticsQuery({ message: 'GET /api/search?q=a%20b -> 200' }), 'a b');

    // 舊格式尾綴（無 ms）與尾隨空白皆須正確剝除。
    assert.equal(
      extractAnalyticsQuery({ message: 'GET /api/search?q=hello ' }), 'hello');

    // 空值不得回傳尾綴。
    assert.equal(
      extractAnalyticsQuery({ message: 'GET /api/search?q= -> 200 (5ms)' }), '');
  });

  test('extractAnalyticsPath 對含空白路徑回傳完整值', () => {
    // 路徑含空白者（真實語料中存在）不得被 [^&\s]+ 截斷。
    const line = 'GET /api/render-chunk?path=NLM/金剛經論釋記 /金剛般若經贊述釋記2.md -> 200 (3ms)';
    assert.equal(
      extractAnalyticsPath({ message: line }),
      'NLM/金剛經論釋記 /金剛般若經贊述釋記2.md');
  });

  test('safeDecodeURI 對畸形 % 具防禦性，單次套用安全', () => {
    assert.equal(safeDecodeURI('100% sure'), '100% sure');
    assert.equal(safeDecodeURI('a%2520b'), 'a%20b');
  });

  test('Logger.error 的解碼路徑仍正確（訊息含 err.message 且單次解碼）', () => {
    Logger.error('Test', 'boom %2520', new Error('bad %2520'));
    assert.equal(lastEntry().message, 'boom %20: bad %20');
  });
});

// ── F12：層級與 query 截斷標記 ──────────────────────────────────────────────
describe('F12 — 層級降級與截斷標記', () => {
  test('建置中止與冷快取讀取失敗已降為 WARN', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /Logger\.info\('Index', `\[Build #\$\{buildId\}\] Aborted/);
    assert.match(src, /Logger\.warn\('Index', `\[Build #\$\{buildId\}\] Aborted during initial directory scan/);
    assert.match(src, /Logger\.warn\('Index', 'Failed to read binary search index cache'/);
    assert.match(src, /Logger\.warn\('DictIndex', 'Failed to read dictionary index cache'/);
    assert.match(src, /Logger\.warn\('Hardware', 'Failed to stat search index cache file'/);
  });

  test('extra.query 超過 300 字元時加上省略標記（不再靜默截斷）', () => {
    Logger.info('Test', 'f12-query', undefined, { query: 'z'.repeat(400) });
    const q = lastEntry().query;
    assert.equal(q.length, 301);
    assert.ok(q.endsWith('…'));
  });

  test('短 query 不受影響、不加上標記', () => {
    Logger.info('Test', 'f12-query-short', undefined, { query: 'short' });
    assert.equal(lastEntry().query, 'short');
  });
});

// ── F6：static-cache / config 失敗不再靜默 ─────────────────────────────────
describe('F6 — static-cache 與 config 失敗記錄', () => {
  test('static-cache.js 具 lazy logger，且在 readFile 失敗處記錄', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'lib/static-cache.js'), 'utf8');
    assert.match(src, /function getLogger\(\)/);
    assert.match(src, /getLogger\(\)\.error\('HTTP', `Failed to read static asset/);
    assert.match(src, /getLogger\(\)\.error\('HTTP', `Failed to stat static asset/);
  });

  test('config.js 的載入/儲存失敗改走 Logger', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'lib/config.js'), 'utf8');
    assert.match(src, /getLogger\(\)\.error\('Config', 'Error loading config'/);
    assert.match(src, /getLogger\(\)\.error\('Config', `Error saving config to/);
    assert.doesNotMatch(src, /console\.error\('Error loading config:'/);
  });

  test('static-cache 的 logger accessor 可安全取得（不拋錯）', () => {
    const mod = require('../lib/static-cache.js');
    assert.equal(typeof mod.serveStatic, 'function');
  });
});

// ── 追加修正：解析器截斷、analyticsStore getter、啟動視窗緩衝 ──────────────
describe('追加 — extractAnalytics* 尾綴剝除與空白容忍', () => {
  test('q= 值含空白時不得被截斷（HTTP 存取記錄路徑）', () => {
    // 這是平行代理修正雙重解碼後仍殘留的缺陷：extractAnalyticsQuery 在未提供
    // entry.query 時走 /q=([^&\s]+)/，遇到解碼後的空白即截斷成第一個詞。
    assert.equal(
      extractAnalyticsQuery({ message: 'GET /api/dict-search?q=一切 法&files=dict:x.md -> 200 (3409ms)' }),
      '一切 法');
    assert.equal(
      extractAnalyticsQuery({ message: 'GET /api/dict-search?q=眾生 佛&f=1 -> 200 (554ms)' }),
      '眾生 佛');
  });

  test('舊格式尾綴（無 ms）亦須剝除，且不得吞掉狀態碼', () => {
    assert.equal(extractAnalyticsQuery({ message: 'GET /api/search?q=a%20b -> 200' }), 'a b');
    assert.doesNotMatch(extractAnalyticsQuery({ message: 'GET /api/search?q=x -> 200' }), /200/);
  });

  test('path= 值含空白時不得被截斷', () => {
    assert.equal(
      extractAnalyticsPath({ message: 'GET /api/render-chunk?path=NLM/金剛經論釋記 /x.md -> 200 (3ms)' }),
      'NLM/金剛經論釋記 /x.md');
  });

  test('空值與尾隨空白皆正確處理', () => {
    assert.equal(extractAnalyticsQuery({ message: 'GET /api/search?q= -> 200 (5ms)' }), '');
    assert.equal(extractAnalyticsQuery({ message: 'GET /api/search?q=hello ' }), 'hello');
  });
});

describe('追加 — D4 analyticsStore 以 getter 匯出', () => {
  test('模組載入時為 null，初始化後可取得實際聚合（非永久 null）', () => {
    const mod = require('../lib/analytics.js');
    // 以 descriptor 確認是 accessor 而非快照值。
    const desc = Object.getOwnPropertyDescriptor(mod, 'analyticsStore');
    assert.ok(desc && typeof desc.get === 'function',
      'analyticsStore 應以 getter 匯出，否則取用端永遠拿到載入時的 null');
  });
});

describe('追加 — D1/D2 Logger 簽章與 IP', () => {
  test('request 物件置於 error() 第 3 參數時被平移，且不產生 [object Object]', () => {
    const fakeReq = { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '203.0.113.7' } };
    Logger.error('Test', 'shifted', fakeReq);
    const e = lastEntry();
    assert.equal(e.ip, '203.0.113.7');
    assert.equal(e.message, 'shifted');
    assert.doesNotMatch(e.message, /\[object/);
  });

  test('info() 第 3 參數為 req 時保留真實 IP', () => {
    const fakeReq = { headers: { 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '198.51.100.9' } };
    Logger.info('Test', 'ip check', fakeReq);
    assert.equal(lastEntry().ip, '198.51.100.9');
  });

  test('server.js 不得再出現 Logger.info(..., null, req)', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /Logger\.info\([^\n]*null,\s*req\)/);
  });
});

describe('追加 — F5 優雅關機僅在真正啟動時註冊', () => {
  test('require server.js 不得註冊 SIGTERM/SIGINT 處理常式', () => {
    const before = { t: process.listenerCount('SIGTERM'), i: process.listenerCount('SIGINT') };
    require('../server.js');
    assert.equal(process.listenerCount('SIGTERM'), before.t);
    assert.equal(process.listenerCount('SIGINT'), before.i);
  });
});

describe('追加 — MAX_LOGIN_ENTRIES 由 lib/auth.js 匯出（不再鏡射）', () => {
  test('auth.js 匯出該常數，server.js 以匯入方式使用', () => {
    const auth = require('../lib/auth.js');
    assert.equal(typeof auth.MAX_LOGIN_ENTRIES, 'number');
    const src = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
    assert.doesNotMatch(src, /^const MAX_LOGIN_ENTRIES\s*=/m,
      'server.js 不應自行重新定義，應由 lib/auth.js 匯入');
  });
});

// ── F13：持久化日誌寫入失敗不得形成無限迴圈 (v3.8.0 迴歸) ────────────────────
/**
 * 修正前：appendToPersistentLog() 的失敗是透過 Logger.error() 回報，而 Logger.error
 * 又會呼叫 appendToPersistentLog()，形成自我維持的無限迴圈。當 LOG_DIR 被刪除
 * （測試收尾、日誌輪替）、磁碟滿或權限不足時，會產生 GB 級輸出並佔滿事件迴圈，
 * 使行程永遠無法結束——在 CI 上表現為測試套件逾時並被取消。
 */
describe('F13 — 持久化日誌寫入失敗不得遞迴自我記錄', () => {
  test('appendFile 持續失敗時不得遞迴呼叫（實測呼叫次數）', async () => {
    const analytics = require('../lib/analytics.js');

    const origAppend = fs.appendFile;
    let appendCalls = 0;
    const stderrWrites = [];
    const origStderrWrite = process.stderr.write;

    // 讓每一次 appendFile 都非同步失敗，模擬 LOG_DIR 被刪除／無權限。
    fs.appendFile = (file, data, cb) => {
      appendCalls++;
      if (typeof cb === 'function') {
        setImmediate(() => cb(Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' })));
      }
      return undefined;
    };
    process.stderr.write = (chunk, ...rest) => { stderrWrites.push(String(chunk)); return true; };

    try {
      analytics.appendToPersistentLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        tag: 'LogPruner',
        message: 'regression probe',
        ip: '127.0.0.1'
      });
      // 留給可能的遞迴足夠時間展開；若修正失效，這裡會暴增到成千上萬次。
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally {
      fs.appendFile = origAppend;
      process.stderr.write = origStderrWrite;
    }

    assert.equal(appendCalls, 1,
      `單次記錄只能觸發一次 appendFile，實際 ${appendCalls} 次；大於 1 代表失敗回報又走回記錄路徑（無限迴圈）`);
    assert.ok(stderrWrites.length <= 1,
      `同一種失敗最多回報一次 stderr，實際 ${stderrWrites.length} 次`);
  });

  test('原始碼不得在 appendToPersistentLog 內以 Logger 回報失敗', () => {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'analytics.js'), 'utf8');
    const start = src.indexOf('function appendToPersistentLog');
    assert.ok(start !== -1, 'lib/analytics.js 應有 appendToPersistentLog');
    const end = src.indexOf('\nfunction ', start + 10);
    const body = src.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(body, /getLogger\(\)\s*\.\s*error/,
      'appendToPersistentLog 內以 Logger 回報失敗會造成無限遞迴（Logger 會再呼叫 appendToPersistentLog）');
  });
});
