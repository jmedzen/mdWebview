/**
 * 經文某一行的短分享連結 /F<14 碼>[L<行>]（lib/share-link.js）
 *
 * 背景：把漢字、書名號都百分比編碼後，一條連結會長到 250 字元，貼進 LINE 很醜；
 * 只編碼部分符號又擋不住 Google Chat 在漢字處斷開。短連結整條只有英數字，
 * 由伺服器用經文清單反查路徑再 302 到 /?file=…&line=…。
 *
 * 本檔包含：
 *   1. lib/share-link 單元測試：碼、解析、NFC、反查、重複。
 *   2. 前後端雜湊對照：app.js 的 shareHash53 / sharePathCode 與 lib/share-link 逐一比對。
 *   3. 伺服器整合測試：真的啟動伺服器，GET /F<碼>L<行> 轉到正確的經文那一行。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const shareLink = require('../lib/share-link');

const ROOT_DIR = path.join(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');

const REPORTED_FILE = '06-菩薩藏/045-049《唯識宗必修論疏》/047 能顯中邊慧日論 疏文斷句.md';

describe('lib/share-link：碼與解析', () => {
  test('14 碼小寫十六進位，同一路徑永遠同一個碼（固定值，改演算法會讓所有已分享的連結失效）', () => {
    assert.equal(shareLink.pathCode('a/b.md'), '0c6f0e6108b124');
    assert.equal(shareLink.pathCode(REPORTED_FILE), '0cc8f84595a4c9');
    assert.match(shareLink.pathCode('任何路徑.md'), /^[0-9a-f]{14}$/);
    assert.equal(shareLink.pathCode(''), '0bdcb81aee8d83');
  });

  test('NFC 與 NFD 寫法的檔名算出同一個碼（macOS 檔名是 NFD）', () => {
    const nfc = '03-論藏/Śūraṅgama.md';
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    assert.equal(shareLink.pathCode(nfd), shareLink.pathCode(nfc));
  });

  test('不同路徑算出不同的碼', () => {
    const codes = new Set();
    for (let i = 0; i < 5000; i++) codes.add(shareLink.pathCode(`01-經藏/${i} 第${i}品.md`));
    assert.equal(codes.size, 5000);
  });

  test('parsePath：大小寫通用、行號可省略', () => {
    assert.deepEqual(shareLink.parsePath('/F0cc8f84595a4c9L738'), { code: '0cc8f84595a4c9', line: 738 });
    assert.deepEqual(shareLink.parsePath('/f0CC8F84595A4C9l738/'), { code: '0cc8f84595a4c9', line: 738 });
    assert.deepEqual(shareLink.parsePath('/F0cc8f84595a4c9'), { code: '0cc8f84595a4c9', line: null });
  });

  test('parsePath：不是短連結的路徑一律回 null（不能吃掉別的路由）', () => {
    for (const p of ['/', '/favicon.ico', '/FAQ', '/F0cc8f84595a4c', '/F0cc8f84595a4c99', '/F0cc8f84595a4c9L',
      '/F0cc8f84595a4c9L12345678', '/F0cc8f84595a4c9/extra', '/Gcc8f84595a4c9', '/api/file', '', null, undefined]) {
      assert.equal(shareLink.parsePath(p), null, String(p));
    }
  });

  test('parsePath：行號 0 視為沒有行號', () => {
    assert.deepEqual(shareLink.parsePath('/F0cc8f84595a4c9L0'), { code: '0cc8f84595a4c9', line: null });
  });
});

describe('lib/share-link：反查', () => {
  const files = [
    { relPath: '01-經藏/甲.md' },
    { relPath: REPORTED_FILE },
    { relPath: '03-論藏/Śūraṅgama.md'.normalize('NFD') }
  ];

  test('由碼找回路徑；找不到回 null', () => {
    assert.deepEqual(shareLink.resolve(files, shareLink.pathCode(REPORTED_FILE)), { path: REPORTED_FILE, ambiguous: false });
    assert.equal(shareLink.resolve(files, '00000000000000'), null);
    assert.equal(shareLink.resolve(files, ''), null);
  });

  test('檔名在磁碟上是 NFD，用 NFC 算出的碼也找得到', () => {
    const r = shareLink.resolve(files, shareLink.pathCode('03-論藏/Śūraṅgama.md'));
    assert.ok(r);
    assert.equal(r.path, '03-論藏/Śūraṅgama.md'.normalize('NFD'));
  });

  test('碼用大寫也找得到', () => {
    assert.ok(shareLink.resolve(files, shareLink.pathCode(REPORTED_FILE).toUpperCase()));
  });

  test('同一份清單只建一次索引', () => {
    assert.equal(shareLink.indexFor(files), shareLink.indexFor(files));
  });

  test('兩個檔案算出同一個碼時取排序後第一個，並標示 ambiguous', () => {
    const a = { relPath: 'b.md' };
    const b = { relPath: 'a.md' };
    const list = [a, b];
    const idx = shareLink.indexFor(list);
    const code = shareLink.pathCode('a.md');
    idx.set(code, ['b.md', 'a.md']); // 模擬碰撞
    const r = shareLink.resolve(list, code);
    assert.deepEqual(r, { path: 'a.md', ambiguous: true });
  });
});

describe('前端與伺服器的雜湊對照', () => {
  function extractFunctionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) return null;
    let i = source.indexOf('{', start);
    let depth = 0;
    let inLine = false;
    let inBlock = false;
    let quote = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];
      if (inLine) { if (ch === '\n') inLine = false; continue; }
      if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') { inLine = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(source.indexOf('{', start), i + 1);
      }
    }
    return null;
  }

  const source = fs.readFileSync(APP_JS, 'utf8');
  let code = '';
  for (const sig of ['function shareHash53(str)', 'function sharePathCode(filePath)']) {
    const body = extractFunctionBody(source, sig);
    assert.ok(body, `app.js 應包含 ${sig}`);
    code += `${sig} ${body}\n`;
  }
  code += 'globalThis.__c = { shareHash53, sharePathCode };';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const client = sandbox.__c;

  const SAMPLES = [
    '', 'a', 'a/b.md', REPORTED_FILE, '01-經藏/「又」《深密經》、疏（上）.md', '甲&乙 #1.md', '50%測試.md',
    '03-論藏/Śūraṅgama.md', '03-論藏/Śūraṅgama.md'.normalize('NFD'), '𠮷野家/𡨸.md', 'emoji/🪷蓮.md',
    'x'.repeat(500), 'dict:佛學辭典/甲.md'
  ];

  test('app.js 的 shareHash53 與 lib/share-link 的 hash53 對所有樣本算出同一個數', () => {
    for (const s of SAMPLES) assert.equal(client.shareHash53(s), shareLink.hash53(s), JSON.stringify(s));
  });

  test('app.js 的 sharePathCode 與 lib/share-link 的 pathCode 對所有樣本相同', () => {
    for (const s of SAMPLES) assert.equal(client.sharePathCode(s), shareLink.pathCode(s), JSON.stringify(s));
    for (let i = 0; i < 2000; i++) {
      const s = `0${i % 9}-經藏/${i} 第${i}品 ${String.fromCharCode(0x4e00 + i)}.md`;
      assert.equal(client.sharePathCode(s), shareLink.pathCode(s));
    }
  });
});

describe('伺服器：短連結轉到經文那一行', () => {
  const tmpDirs = [];
  let child;
  let port;

  const request = (urlPath, headers, method) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: method || 'GET', headers: headers || {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  const GOOGLEBOT = { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' };

  const FILES = [
    { rel: REPORTED_FILE, title: '短連結標題甲' },
    { rel: '05-經藏/甲&乙 #1.md', title: '短連結標題乙' },
    { rel: '05-經藏/C++導論 (50%).md', title: '短連結標題丙' }
  ];

  before(async () => {
    const mdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-short-md-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-short-cfg-'));
    tmpDirs.push(mdRoot, cfgDir);
    for (const f of FILES) {
      const full = path.join(mdRoot, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `# ${f.title}\n\n第一段。\n\n第二段。\n`, 'utf-8');
    }
    const configPath = path.join(cfgDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ settings: { mdRoot } }), 'utf-8');

    ({ child, port } = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT_DIR,
        env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', MD_ROOT: mdRoot, CONFIG_PATH: configPath })
      });
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/MDWEBVIEW_READY port=(\d+)/);
        if (m) { c.stdout.off('data', onData); resolve({ child: c, port: parseInt(m[1], 10) }); }
      };
      c.stdout.on('data', onData);
      c.stderr.on('data', () => {});
      c.on('error', reject);
      c.on('exit', (code) => {
        if (!buf.includes('MDWEBVIEW_READY')) reject(new Error(`server exited early (${code}): ${buf.slice(-500)}`));
      });
      setTimeout(() => reject(new Error('server did not become ready in time')), 30000).unref();
    }));
  });

  after(async () => {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000).unref();
      });
    }
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const f of FILES) {
    test(`/F<碼>L2 轉到「${f.rel}」第 2 行，轉址後爬蟲拿到該檔案的預覽`, async () => {
      const code = shareLink.pathCode(f.rel);
      const res = await request(`/F${code}L2`);
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, `/?file=${encodeURIComponent(f.rel)}&line=2`);
      assert.match(res.headers.location, /^[\x21-\x7e]+$/, 'Location 標頭必須是純 ASCII');
      assert.equal(res.headers['cache-control'], 'no-store');

      const page = await request(res.headers.location, GOOGLEBOT);
      assert.equal(page.statusCode, 200);
      assert.ok(page.body.includes(f.title), '轉址後的預覽頁應含該檔案的標題');
    });
  }

  test('沒有行號的短連結轉到整篇；大寫碼也行', async () => {
    const f = FILES[0];
    const res = await request(`/F${shareLink.pathCode(f.rel).toUpperCase()}`);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/?file=${encodeURIComponent(f.rel)}`);
  });

  test('HEAD 請求也能轉址（部分聊天軟體先用 HEAD 探路）', async () => {
    const res = await request(`/F${shareLink.pathCode(FILES[1].rel)}L9`, {}, 'HEAD');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/?file=${encodeURIComponent(FILES[1].rel)}&line=9`);
  });

  test('找不到的碼（檔案改名或刪除）回首頁，不報錯', async () => {
    const res = await request('/F00000000000000L5');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/');
  });

  test('不影響其他路由：首頁與 favicon 照常', async () => {
    assert.equal((await request('/')).statusCode, 200);
    assert.equal((await request('/favicon.ico')).statusCode, 200);
  });
});
