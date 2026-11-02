/**
 * @file test-index-dir.test.js
 * v4.19.0：索引快取從 logs/ 搬到獨立的 index/ 目錄。
 *   - INDEX_DIR 預設為 <MDW_USER_DATA>/index，可用環境變數覆寫。
 *   - 舊站台 logs/ 裡的索引在啟動時搬到 index/（不必重建）。
 *   - 跨檔案系統（Docker 不同掛載點）時改用複製；新目錄已有檔案時以新的為準。
 *   - Docker 映像、entrypoint、compose 都要把 index 目錄準備好並交給 node 使用者。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { INDEX_CACHE_FILES, migrateLegacyIndexFiles } = require('../lib/index-dir');
const ROOT = path.join(__dirname, '..');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-index-dir-')); }

test('INDEX_DIR 預設在 MDW_USER_DATA/index，可用 INDEX_DIR 覆寫', () => {
  const userData = tmp();
  const read = (env) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./lib/constants').INDEX_DIR)"], {
    cwd: ROOT, env: Object.assign({}, process.env, { INDEX_DIR: '', LOG_DIR: '' }, env), encoding: 'utf8'
  });
  assert.equal(read({ MDW_USER_DATA: userData, INDEX_DIR: '' }), path.join(userData, 'index'));
  assert.equal(read({ MDW_USER_DATA: userData, INDEX_DIR: '/srv/mdw-index' }), '/srv/mdw-index');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('server.js 的索引快取路徑都在 INDEX_DIR，不在 LOG_DIR', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const name of INDEX_CACHE_FILES) {
    assert.ok(src.includes(`path.join(INDEX_DIR, '${name}')`), `${name} 應寫在 INDEX_DIR`);
    assert.ok(!src.includes(`path.join(LOG_DIR, '${name}')`), `${name} 不應再寫在 LOG_DIR`);
  }
  // 遷移必須在開機時、任何索引載入之前執行。
  const migrateAt = src.indexOf('migrateLegacyIndexFiles({ logDir: LOG_DIR');
  const buildAt = src.indexOf("Logger.info('Boot', 'Pre-warming Bigram Index");
  assert.ok(migrateAt > 0, '啟動時要呼叫 migrateLegacyIndexFiles');
  assert.ok(migrateAt < src.lastIndexOf('listenWithFallback(server, PORT'), '遷移要在 listen 之前');
  assert.ok(buildAt > migrateAt, '遷移要在預熱索引之前');
});

test('舊 logs/ 的索引檔搬到 index/，日誌留在原處', () => {
  const root = tmp();
  const logDir = path.join(root, 'logs');
  const indexDir = path.join(root, 'index');
  fs.mkdirSync(logDir);
  for (const name of INDEX_CACHE_FILES) fs.writeFileSync(path.join(logDir, name), `data:${name}`);
  fs.writeFileSync(path.join(logDir, 'search-index-cache.bin.tmp'), 'half');
  fs.writeFileSync(path.join(logDir, 'access-2026-11-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(logDir, 'analytics-aggregates.json'), '{}');

  const r = migrateLegacyIndexFiles({ logDir, indexDir });
  assert.deepEqual(r.moved.sort(), [...INDEX_CACHE_FILES].sort());
  for (const name of INDEX_CACHE_FILES) {
    assert.equal(fs.readFileSync(path.join(indexDir, name), 'utf8'), `data:${name}`);
    assert.ok(!fs.existsSync(path.join(logDir, name)), `${name} 應從 logs/ 移走`);
  }
  assert.ok(!fs.existsSync(path.join(logDir, 'search-index-cache.bin.tmp')), '中斷留下的暫存檔應清掉');
  assert.ok(fs.existsSync(path.join(logDir, 'access-2026-11-01.jsonl')), '日誌不能被搬走');
  assert.ok(fs.existsSync(path.join(logDir, 'analytics-aggregates.json')), '分析庫不能被搬走');

  // 再跑一次：沒有東西可搬，不出錯。
  assert.deepEqual(migrateLegacyIndexFiles({ logDir, indexDir }).moved, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('index/ 已有同名檔時保留新的、刪掉舊的', () => {
  const root = tmp();
  const logDir = path.join(root, 'logs');
  const indexDir = path.join(root, 'index');
  fs.mkdirSync(logDir); fs.mkdirSync(indexDir);
  fs.writeFileSync(path.join(logDir, 'dict-index-cache.bin'), 'old');
  fs.writeFileSync(path.join(indexDir, 'dict-index-cache.bin'), 'new');
  const r = migrateLegacyIndexFiles({ logDir, indexDir });
  assert.deepEqual(r.skipped, ['dict-index-cache.bin']);
  assert.equal(fs.readFileSync(path.join(indexDir, 'dict-index-cache.bin'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(path.join(logDir, 'dict-index-cache.bin')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('跨檔案系統（EXDEV）改用複製後刪除舊檔', (t) => {
  const root = tmp();
  const logDir = path.join(root, 'logs');
  const indexDir = path.join(root, 'index');
  fs.mkdirSync(logDir);
  fs.writeFileSync(path.join(logDir, 'search-index-cache.bin'), 'bigram');
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).startsWith(logDir)) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    return realRename(from, to);
  });
  const r = migrateLegacyIndexFiles({ logDir, indexDir });
  t.mock.restoreAll();
  assert.deepEqual(r.moved, ['search-index-cache.bin']);
  assert.equal(fs.readFileSync(path.join(indexDir, 'search-index-cache.bin'), 'utf8'), 'bigram');
  assert.ok(!fs.existsSync(path.join(logDir, 'search-index-cache.bin')));
  assert.deepEqual(fs.readdirSync(indexDir), ['search-index-cache.bin'], '不應留下暫存檔');
  fs.rmSync(root, { recursive: true, force: true });
});

test('INDEX_DIR 與 LOG_DIR 相同（維持舊行為）時不搬也不刪', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'search-index-cache.bin'), 'x');
  const r = migrateLegacyIndexFiles({ logDir: root, indexDir: root });
  assert.deepEqual(r, { moved: [], skipped: [], failed: [] });
  assert.ok(fs.existsSync(path.join(root, 'search-index-cache.bin')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('logs/ 不存在時直接略過（全新安裝）', () => {
  const root = tmp();
  const r = migrateLegacyIndexFiles({ logDir: path.join(root, 'nope'), indexDir: path.join(root, 'index') });
  assert.deepEqual(r, { moved: [], skipped: [], failed: [] });
  assert.ok(!fs.existsSync(path.join(root, 'index')), '沒東西可搬就不必建目錄');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Docker：映像、entrypoint、compose 都準備好 index 目錄', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /INDEX_DIR=\/data\/index/);
  assert.match(dockerfile, /mkdir -p [^\n]*\/data\/index/);
  assert.match(dockerfile, /chown node:node [^\n]*\/data\/index/);

  const entry = fs.readFileSync(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8');
  assert.match(entry, /INDEX="\$\{INDEX_DIR:-\/data\/index\}"/);
  assert.match(entry, /chown -R node:node "\$INDEX"/);

  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /- \.\/index:\/data\/index/);
  assert.match(compose, /INDEX_DIR=\/data\/index/);

  assert.match(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'), /^index$/m);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^index\/\*$/m);
});

test('靜態檔案服務封鎖 index/ 目錄', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'static-cache.js'), 'utf8');
  assert.match(src, /'logs', 'index', 'dicts'/);
});
