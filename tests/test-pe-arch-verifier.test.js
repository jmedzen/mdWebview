/**
 * @file tests/test-pe-arch-verifier.test.js
 *
 * Regression tests for desktop/scripts/verify-pe-arch.sh.
 *
 * Why this matters
 * ----------------
 * The Windows packaging jobs cross-compile: an ARM64 sidecar and an ARM64 app
 * are produced on an x64 runner. If a download, a cache hit or a matrix flag
 * silently yields the wrong architecture, every other check still passes —
 * nothing else inspects the produced PE files, only the YAML strings.
 *
 * The failure mode is a published release that installs on x64 and dies on
 * ARM64 (or vice versa) with no CI signal. This verifier reads the PE
 * `Machine` field out of the header, so filenames and matrix labels cannot
 * fool it.
 *
 * The script runs on the Windows runners in Git Bash, so these tests use a
 * synthetic PE header rather than depending on real installers being present.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT_DIR, 'desktop', 'scripts', 'verify-pe-arch.sh');

/** Build a minimal but structurally valid PE file with a chosen machine type. */
function makePe(machine) {
  const buf = Buffer.alloc(0x200, 0);
  buf.write('MZ', 0, 'ascii');           // DOS magic
  buf.writeUInt32LE(0x80, 0x3c);         // e_lfanew -> PE header offset
  buf.write('PE\0\0', 0x80, 'ascii');    // PE signature
  buf.writeUInt16LE(machine, 0x84);      // COFF Machine field
  return buf;
}

const MACHINE = { i386: 0x014c, amd64: 0x8664, arm64: 0xaa64 };

describe('PE 架構驗證腳本 (verify-pe-arch.sh)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-pe-'));
  });

  /** Write a fixture and run the verifier; return {ok, stderr}. */
  function run(expectedArch, fileName, buf) {
    const file = path.join(tmpDir, fileName);
    fs.writeFileSync(file, buf);
    try {
      const stdout = execFileSync('bash', [SCRIPT, expectedArch, file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { ok: true, output: stdout };
    } catch (err) {
      return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  test('x64 檔案以 x64 驗證應通過', () => {
    const r = run('x64', 'amd64.exe', makePe(MACHINE.amd64));
    assert.equal(r.ok, true, `應通過，實際輸出：${r.output}`);
  });

  test('arm64 檔案以 arm64 驗證應通過', () => {
    const r = run('arm64', 'arm64.exe', makePe(MACHINE.arm64));
    assert.equal(r.ok, true, `應通過，實際輸出：${r.output}`);
  });

  test('arm64 檔案誤標為 x64 必須被擋下（發佈錯誤架構的實際風險）', () => {
    const r = run('x64', 'wrong-arm64-as-x64.exe', makePe(MACHINE.arm64));
    assert.equal(r.ok, false, '把 arm64 當成 x64 出貨必須失敗');
  });

  test('x64 檔案誤標為 arm64 必須被擋下', () => {
    const r = run('arm64', 'wrong-x64-as-arm64.exe', makePe(MACHINE.amd64));
    assert.equal(r.ok, false, '把 x64 當成 arm64 出貨必須失敗');
  });

  test('32 位元 NSIS/MSI 安裝器 stub 不得被誤判為目標架構', () => {
    // 安裝器外層固定是 32 位元；若誤把安裝檔當成檢查對象，
    // 這個檢查會變成永遠失敗的假警報，或永遠通過的假保證。
    for (const arch of ['x64', 'arm64']) {
      const r = run(arch, `stub-${arch}.exe`, makePe(MACHINE.i386));
      assert.equal(r.ok, false, `i386 stub 不得通過 ${arch} 驗證`);
    }
  });

  test('架構名稱不分大小寫', () => {
    for (const variant of ['X64', 'x64', 'AMD64', 'amd64']) {
      const r = run(variant, 'case-amd64.exe', makePe(MACHINE.amd64));
      assert.equal(r.ok, true, `${variant} 應被接受，實際輸出：${r.output}`);
    }
    for (const variant of ['ARM64', 'arm64', 'AARCH64', 'aarch64']) {
      const r = run(variant, 'case-arm64.exe', makePe(MACHINE.arm64));
      assert.equal(r.ok, true, `${variant} 應被接受，實際輸出：${r.output}`);
    }
  });

  test('未知架構名稱應以非零狀態結束', () => {
    const r = run('riscv', 'x.exe', makePe(MACHINE.amd64));
    assert.equal(r.ok, false, '未知架構不應被當成通過');
  });

  test('非 PE 檔案必須被拒絕', () => {
    const r = run('x64', 'not-a-pe.exe', Buffer.from('this is plain text, not a PE\n'));
    assert.equal(r.ok, false, '非 PE 檔案不得被視為有效');
  });

  test('檔案不存在必須被拒絕', () => {
    try {
      execFileSync('bash', [SCRIPT, 'x64', path.join(tmpDir, 'does-not-exist.exe')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      assert.fail('缺少檔案時應以非零狀態結束');
    } catch (err) {
      assert.notEqual(err.status, 0, '缺少檔案時應以非零狀態結束');
    }
  });

  test('多檔案時任一錯誤即整體失敗', () => {
    const good = path.join(tmpDir, 'multi-good.exe');
    const bad = path.join(tmpDir, 'multi-bad.exe');
    fs.writeFileSync(good, makePe(MACHINE.amd64));
    fs.writeFileSync(bad, makePe(MACHINE.arm64));

    try {
      execFileSync('bash', [SCRIPT, 'x64', good, bad], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      assert.fail('清單中含錯誤架構時應整體失敗');
    } catch (err) {
      assert.notEqual(err.status, 0, '清單中含錯誤架構時應整體失敗');
    }
  });
});

describe('CI 工作流程必須把 PE 驗證接在正確的產物上', () => {
  const workflow = () =>
    fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'desktop-packages.yml'), 'utf8');

  test('Windows 各架構列都必須執行架構驗證', () => {
    const yml = workflow();
    assert.match(yml, /verify-pe-arch\.sh/, 'CI 應呼叫 verify-pe-arch.sh');
    // 每個 Windows 列都帶 win_arch，且驗證步驟以它為條件。
    const winArchValues = [...yml.matchAll(/win_arch:\s*(\S*)/g)].map((m) => m[1].replace(/['"]/g, ''));
    assert.ok(winArchValues.includes('x64'), '應有 x64 的 Windows 列');
    assert.ok(winArchValues.includes('arm64'), '應有 arm64 的 Windows 列');
    assert.match(yml, /if:\s*matrix\.win_arch\s*!=\s*''/,
      '驗證步驟應只在指定架構的列執行');
  });

  test('驗證對象必須是 sidecar 與 app 執行檔，而非 32 位元安裝器 stub', () => {
    const yml = workflow();
    assert.match(yml, /mdwebview-server-\$\{\{\s*matrix\.triple\s*\}\}\.exe/,
      '應驗證 sidecar（即 Node 執行檔本體）');
    assert.match(yml, /-name\s+'mdwebview\.exe'/, '應驗證 Rust app 執行檔');
  });
});
