/**
 * @file desktop/electron/main.js — Electron main process for mdWebview
 *
 * Architecture
 * ------------
 * mdWebview is a Node.js HTTP server that serves its own SPA. Rather than
 * reimplementing it, Electron runs `server.js` as a *real Node.js process* via
 * the `ELECTRON_RUN_AS_NODE` switch. That matters because the server spawns
 * `worker_threads` from files on disk (render-worker.js / index-worker.js) and
 * resolves its static assets relative to `process.cwd()`; running it as a
 * genuine Node child keeps both behaviours exactly as they are in the
 * Docker/server deployment, with zero changes to the app itself.
 *
 * The window then simply points at http://127.0.0.1:<port>.
 *
 * Read-only app dir, writable user data
 * -------------------------------------
 * The application payload lives beside the executable (read-only, versioned by
 * the installer). Everything writable — config.json, logs, and the multi-hundred
 * -MB bigram index caches — is directed into Electron's per-user data directory
 * through MDW_USER_DATA / CONFIG_PATH / LOG_DIR / MD_ROOT, so installers and
 * future auto-updates never touch user data.
 */

'use strict';

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ── Stable identity ───────────────────────────────────────────────────────
// The writable data directory must be the SAME on every platform and in both
// dev and packaged builds. Left to itself Electron derives it from whichever
// name source each platform happens to expose — package.json `name`
// ("mdwebview-desktop") in the packaged asar — so users would get a different
// folder than the one documented and than the installer's shortcuts suggest.
//
// Pin the name explicitly, then choose the directory defensively.
const PRODUCT_NAME = 'mdWebview-Electron';
app.setName(PRODUCT_NAME);

/**
 * Pick the per-user writable directory, verifying it can actually be created.
 *
 * A single hard-coded location is not enough: on managed or migrated Windows
 * profiles `%APPDATA%` may point at a broken or unreachable location, and
 * `mkdir` then fails with `ENOENT` — which aborts startup with no usable app.
 * Node maps several distinct Win32 errors (ERROR_PATH_NOT_FOUND,
 * ERROR_INVALID_NAME, ERROR_BAD_PATHNAME, …) onto that one code, so the
 * message alone does not say which component is at fault.
 *
 * Try the documented location first, then a per-machine one, and report every
 * attempt if none works.
 */
function selectUserDataDir() {
  const roaming = path.join(app.getPath('appData'), PRODUCT_NAME);
  const candidates = [roaming];
  // Secondary: LOCALAPPDATA ("AppData\Local") is per-machine and is frequently
  // left intact even when a roaming profile is redirected or damaged.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, PRODUCT_NAME));
  }

  const failures = [];
  for (const dir of candidates) {
    try {
      // Attach any data left under the old name before creating this one, so
      // the rename is not mistaken for data loss.
      migrateLegacyUserData(dir);
      fs.mkdirSync(dir, { recursive: true });
      // Confirm we can actually write, not merely that a name exists.
      fs.accessSync(dir, fs.constants.W_OK);
      return { dir, failures, temporary: false };
    } catch (err) {
      failures.push(`${dir}\n    ${err.code || 'ERROR'}: ${err.message}`);
    }
  }

  // Last resort: the OS temp directory. This keeps the app usable, but it is
  // NOT a safe home for real data — the portable build runs from a random
  // %TEMP% subdirectory that its own launcher deletes on exit, and temp is
  // subject to Disk Cleanup. The vault and the multi-hundred-MB index live
  // here, so the caller must warn the user loudly rather than relocate
  // silently.
  const tmpDir = path.join(os.tmpdir(), PRODUCT_NAME);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.accessSync(tmpDir, fs.constants.W_OK);
    return { dir: tmpDir, failures, temporary: true };
  } catch (err) {
    failures.push(`${tmpDir}\n    ${err.code || 'ERROR'}: ${err.message}`);
  }
  return { dir: candidates[0], failures, temporary: false };
}

/** True when the directory exists and contains at least one entry. */
function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Older builds resolved their data directory from the package name, so users
 * may already have data under `mdwebview-desktop`. Move it to the documented
 * location before anything creates the new directory, so renaming the folder
 * does not look like data loss.
 *
 * Only the sibling `mdwebview-desktop` is considered, so this cannot reach
 * across into an unrelated location.
 */
function migrateLegacyUserData(target) {
  const legacy = path.join(path.dirname(target), 'mdwebview-desktop');
  if (legacy === target || !fs.existsSync(legacy)) return;
  // Nothing to do if the documented directory already holds real data.
  if (hasEntries(target)) return;
  try {
    if (fs.existsSync(target)) fs.rmdirSync(target); // empty leftover
    // rename() fails across volumes; fall back to a recursive copy.
    try {
      fs.renameSync(legacy, target);
    } catch {
      fs.cpSync(legacy, target, { recursive: true });
    }
  } catch {
    // Migration is best-effort: never block startup over it.
  }
}

const userDataSelection = selectUserDataDir();
app.setPath('userData', userDataSelection.dir);

// ── Single instance ───────────────────────────────────────────────────────
// Two copies would race for the same user-data directory and index caches.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {import('child_process').ChildProcess|null} */
let serverProcess = null;
/** @type {BrowserWindow|null} */
let mainWindow = null;
/** Port the HTTP server actually bound to (resolved once it is ready). */
let serverPort = null;

const isDev = !app.isPackaged;

/**
 * Root of the read-only application payload (server.js, lib/, index.html, ...).
 * In a packaged app electron-builder places these under `resources/app`.
 */
function appPayloadDir() {
  return isDev
    ? path.resolve(__dirname, '..', '..')
    : path.join(process.resourcesPath, 'app');
}

/** Per-user writable directory: config, logs and index caches. */
function userDataDir() {
  return app.getPath('userData');
}

/** Path to a Node.js executable capable of running the server. */
function nodeExecutable() {
  // Electron ships a full Node runtime; ELECTRON_RUN_AS_NODE turns this very
  // binary into that runtime, so no separate Node install is required.
  return process.execPath;
}

/**
 * Wait until the server prints its machine-readable readiness line.
 * Resolves with the chosen port, or rejects on timeout / early exit.
 */
function waitForServerReady(child, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(
        `伺服器在 ${Math.round(timeoutMs / 1000)} 秒內未完成啟動。\n\n` +
        `若這是首次啟動，可能正在建立全文索引，請稍候再試。`
      ));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      // Emitted by server.js after listen() succeeds.
      const m = buffer.match(/MDWEBVIEW_READY port=(\d+)/);
      if (m) finish(resolve, Number(m[1]));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('exit', (code) => {
      finish(reject, new Error(`伺服器行程意外結束（代碼 ${code}）。`));
    });
    child.once('error', (err) => finish(reject, err));
  });
}

/** Poll the port until it answers, guarding against a bind race. */
function waitForHttp(port, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('伺服器已啟動但無法連線。'));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

/** Prepare the writable tree and spawn the Node server. */
function startServer() {
  const payload = appPayloadDir();
  const serverEntry = path.join(payload, 'server.js');

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`找不到伺服器檔案：${serverEntry}`);
  }

  const userData = userDataDir();
  const logsDir = path.join(userData, 'logs');
  const vaultDir = path.join(userData, 'md');
  const dictDir = path.join(userData, 'dicts');
  // `userData` itself was already created and write-checked by
  // selectUserDataDir(); these are the server's own subdirectories. Create
  // them individually so a failure names the offending path instead of
  // surfacing a bare ENOENT from somewhere deep in startup.
  for (const dir of [userData, logsDir, vaultDir, dictDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new Error(
        `無法建立資料目錄：${dir}\n` +
        `（${err.code || 'ERROR'}: ${err.message}）\n` +
        '請確認磁碟空間充足，且目前的使用者對該位置有寫入權限。'
      );
    }
  }

  const child = spawn(
    nodeExecutable(),
    [serverEntry],
    {
      cwd: payload, // server.js resolves assets & workers from cwd
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1', // run as plain Node, no Electron window
        NODE_ENV: isDev ? 'development' : 'production',
        // Desktop defaults: loopback only, ephemeral port, separate data dir.
        HOST: '127.0.0.1',
        PORT: '0',
        MDW_USER_DATA: userData,
        CONFIG_PATH: path.join(userData, 'config.json'),
        LOG_DIR: logsDir,
        MD_ROOT: vaultDir,
        DICTIONARY_PATH: dictDir,
        // The bigram index is ~700MB for a large vault; give Node headroom the
        // same way the Docker image does.
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=4096'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  // Surface server output in the terminal when running from source.
  if (isDev) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }

  serverProcess = child;
  return child;
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  const child = serverProcess;
  serverProcess = null;
  serverPort = null;
  try {
    // server.js installs SIGTERM/SIGINT handlers for a graceful shutdown
    // (flush index caches, terminate worker pools) — give it a moment.
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000);
    child.once('exit', () => clearTimeout(killTimer));
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 480,
    minHeight: 480,
    backgroundColor: '#1e1e1e',
    title: 'mdWebview (Electron)',
    show: false,
    webPreferences: {
      // The reader is an ordinary web app served over loopback; it needs no
      // Node integration and no preload bridge.
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links (canonical citations, dictionary references) open in the
  // user's browser instead of hijacking the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // A renderer crash should be recoverable without losing the server.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason !== 'clean-exit') {
      mainWindow.reload();
    }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '關於 mdWebview (Electron)' },
        { type: 'separator' },
        { role: 'hide', label: '隱藏' },
        { role: 'hideOthers', label: '隱藏其他' },
        { role: 'unhide', label: '顯示全部' },
        { type: 'separator' },
        { role: 'quit', label: '結束' }
      ]
    }] : []),
    {
      label: '檔案',
      submenu: [
        {
          label: '開啟資料目錄',
          click: () => shell.openPath(userDataDir())
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '關閉視窗' } : { role: 'quit', label: '結束' }
      ]
    },
    {
      label: '編輯',
      submenu: [
        { role: 'undo', label: '復原' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪下' },
        { role: 'copy', label: '複製' },
        { role: 'paste', label: '貼上' },
        { role: 'selectAll', label: '全選' },
        { type: 'separator' },
        { role: 'find', label: '頁內搜尋' }
      ]
    },
    {
      label: '檢視',
      submenu: [
        { role: 'reload', label: '重新載入' },
        { role: 'resetZoom', label: '重設縮放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全螢幕' },
        ...(isDev ? [
          { type: 'separator' },
          { role: 'toggleDevTools', label: '開發者工具' }
        ] : [])
      ]
    },
    {
      label: '視窗',
      submenu: [
        { role: 'minimize', label: '縮到最小' },
        { role: 'zoom', label: '縮放' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '全部置前' }] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  try {
    // Falling back to the temp directory keeps the app running, but that is
    // not a durable home for the vault and its index — warn before the user
    // starts relying on it.
    if (userDataSelection.temporary) {
      const attempted = userDataSelection.failures.length
        ? '\n\n原本嘗試的位置：\n  ' + userDataSelection.failures.join('\n  ')
        : '';
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'mdWebview (Electron)',
        message: '無法使用標準資料目錄，已改用暫存資料夾',
        detail:
          `目前的資料目錄：\n  ${userDataDir()}\n\n` +
          '這個位置是暫存資料夾，可能被系統清理程式刪除，' +
          '其中的筆記與索引快取並不安全。\n' +
          '請將筆記另存到其他位置，並檢查磁碟剩餘空間與帳戶權限。' +
          attempted
      });
    }
    const child = startServer();
    const port = await waitForServerReady(child);
    serverPort = port;
    await waitForHttp(port);
    createWindow(port);
  } catch (err) {
    const attempted = userDataSelection.failures.length
      ? '\n\n已嘗試的資料目錄：\n  ' + userDataSelection.failures.join('\n  ')
      : '';
    dialog.showErrorBox(
      'mdWebview (Electron) 啟動失敗',
      `${err && err.message ? err.message : err}\n\n` +
      `資料目錄：${userDataDir()}${attempted}`
    );
    stopServer();
    app.quit();
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  buildMenu();
  boot();

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
      createWindow(serverPort);
    }
  });
});

app.on('window-all-closed', () => {
  // The server is a child of this process, so quitting the app must stop it on
  // every platform — including macOS, where windows normally close independently.
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
process.on('exit', stopServer);
