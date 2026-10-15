/**
 * @file tests/test-port-selection.test.js
 *
 * The desktop shells pin a fixed local port because localStorage is scoped to
 * the page origin (`http://127.0.0.1:<port>`). Before this, both shells asked
 * for PORT=0 and silently orphaned every user preference on each restart.
 *
 * A fixed port introduces a new failure mode — the port may already be in use —
 * so the server must walk to a neighbouring port instead of crashing on an
 * unhandled 'error' event.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT_DIR = path.resolve(__dirname, '..');

/** Occupy a port so the next bind attempt on it must fail with EADDRINUSE. */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.once('error', reject);
  });
}

function startServer(env, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server not ready in time:\n${out}`));
    }, timeoutMs);
    const onData = (c) => {
      out += c.toString();
      const m = out.match(/MDWEBVIEW_READY port=(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (c) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${c}):\n${out}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 8000).unref();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('固定連接埠與衝突時的埠掃描', () => {
  const dirs = [];
  const children = [];

  function makeUserData(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  after(async () => {
    for (const c of children) await stopServer(c);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  });

  test('指定連接埠可正常啟動並服務請求', async () => {
    const desired = await freePort();
    const userData = makeUserData('mdw-port-ok-');
    const started = await startServer({
      MDW_DEPLOY_TARGET: 'win-app',
      PORT: String(desired),
      MDW_PORT_SCAN: '1',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: path.join(userData, 'md'),
      DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    children.push(started.child);

    assert.equal(started.port, desired, '未被占用的連接埠應直接使用，確保 origin 穩定');
    assert.equal(await get(started.port, '/api/tree'), 200);
  });

  test('連接埠被占用時改用下一個可用埠，而非崩潰', async () => {
    const desired = await freePort();
    const blocker = await occupyPort(desired);
    try {
      const userData = makeUserData('mdw-port-busy-');
      const started = await startServer({
        MDW_DEPLOY_TARGET: 'win-app',
        PORT: String(desired),
        MDW_PORT_SCAN: '1',
        HOST: '127.0.0.1',
        MDW_USER_DATA: userData,
        CONFIG_PATH: path.join(userData, 'config.json'),
        LOG_DIR: path.join(userData, 'logs'),
        MD_ROOT: path.join(userData, 'md'),
        DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
      });
      children.push(started.child);

      assert.equal(started.port, desired + 1,
        '被占用時應改用下一個連接埠');
      assert.equal(await get(started.port, '/api/tree'), 200,
        '掃描後的連接埠必須實際可服務');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  test('未啟用埠掃描且連接埠被占用時，以明確錯誤結束（不留下半啟動狀態）', async () => {
    const desired = await freePort();
    const blocker = await occupyPort(desired);
    try {
      const userData = makeUserData('mdw-port-fail-');
      await assert.rejects(
        () => startServer({
          MDW_DEPLOY_TARGET: 'win-app',
          PORT: String(desired),
          // MDW_PORT_SCAN deliberately unset: without it a busy port is fatal.
          HOST: '127.0.0.1',
          MDW_USER_DATA: userData,
          CONFIG_PATH: path.join(userData, 'config.json'),
          LOG_DIR: path.join(userData, 'logs'),
          MD_ROOT: path.join(userData, 'md'),
          DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
        }, 20000),
        (err) => /exited early|failed to start|EADDRINUSE/i.test(err.message),
        '未啟用掃描時應以清楚的錯誤收場'
      );
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  test('PORT=0 仍要求作業系統指派（保留既有行為）', async () => {
    const userData = makeUserData('mdw-port-zero-');
    const started = await startServer({
      MDW_DEPLOY_TARGET: 'win-app',
      PORT: '0',
      HOST: '127.0.0.1',
      MDW_USER_DATA: userData,
      CONFIG_PATH: path.join(userData, 'config.json'),
      LOG_DIR: path.join(userData, 'logs'),
      MD_ROOT: path.join(userData, 'md'),
      DICTIONARY_ENABLED: 'false',
      // Keep this spawned server small: several test files run concurrently and
      // CPU-derived worker pools would oversubscribe the machine.
      MDW_RENDER_POOL_SIZE: '2',
      MDW_INDEX_POOL_SIZE: '2'
    });
    children.push(started.child);
    assert.ok(started.port > 0, 'PORT=0 應取得一個有效連接埠');
    assert.equal(await get(started.port, '/api/tree'), 200);
  });
});
