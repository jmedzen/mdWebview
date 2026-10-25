const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT_DIR, 'app.js');
const appSource = fs.readFileSync(APP_JS, 'utf8');

/**
 * 從 app.js 取出函式主體（以大括號配對到結尾），跳過字串與樣板內的括號。
 *
 * 注意：必須從「函式宣告處」開始找起，不能從 JSDoc 開始——註解裡常有
 * `@param {string}` 這類大括號，會讓配對提前失衡。
 */
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const braceStart = source.indexOf('{', start + signature.length);
  if (braceStart === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return null;
}

/**
 * 在沙箱中載入 isSimplifiedChineseLocale 與 maybeAutoEnableS2TFromLocale，
 * 並提供可注入的 navigator 與 storage。
 */
function loadS2TLocale(options = {}) {
  const { navigatorLanguage = 'zh-TW', storedValue = null, storageThrows = false } = options;

  const simplifiedSig = 'function isSimplifiedChineseLocale(lang)';
  const maybeSig = 'function maybeAutoEnableS2TFromLocale()';
  const simplifiedBody = extractFunctionBody(appSource, simplifiedSig);
  const maybeBody = extractFunctionBody(appSource, maybeSig);
  assert.ok(simplifiedBody, `app.js 應包含 ${simplifiedSig}`);
  assert.ok(maybeBody, `app.js 應包含 ${maybeSig}`);

  const code =
    `${simplifiedSig} ${simplifiedBody}\n` +
    `${maybeSig} ${maybeBody}\n` +
    'globalThis.__isSimplified = isSimplifiedChineseLocale;' +
    'globalThis.__maybeAuto = maybeAutoEnableS2TFromLocale;';

  const sandbox = {
    navigator: { language: navigatorLanguage },
    STORAGE_KEYS: { AUTO_S2T: 'mdWebview-auto-s2t' },
    storage: {
      _value: storedValue,
      get(key) {
        if (storageThrows) throw new Error('storage unavailable');
        return this._value;
      },
      set(key, val) {
        if (storageThrows) throw new Error('storage unavailable');
        this._value = val;
      }
    },
    Number,
    String,
    RegExp,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

describe('簡體中文瀏覽器自動開啟簡繁字形一併比對（AUTO_S2T）', () => {
  describe('語言判定 isSimplifiedChineseLocale', () => {
    const simplified = [
      'zh-CN', 'zh-cn', 'zh_CN', 'zh-Hans', 'zh-hans',
      'zh-Hans-CN', 'zh-Hant-CN', 'zh-SG', 'zh_CN.UTF-8'
    ];
    const notSimplified = [
      'zh-TW', 'zh-HK', 'zh-Hant', 'zh-TW-x-private',
      'en', 'en-US', 'ja', 'ko', '', 'zh'
    ];

    test('應判定為簡體中文的語言標籤', () => {
      const box = loadS2TLocale();
      for (const tag of simplified) {
        assert.equal(
          box.__isSimplified(tag), true,
          `${tag} 應判定為簡體中文`
        );
      }
    });

    test('不應判定為簡體中文的語言標籤', () => {
      const box = loadS2TLocale();
      for (const tag of notSimplified) {
        assert.equal(
          box.__isSimplified(tag), false,
          `${tag} 不應判定為簡體中文`
        );
      }
    });

    test('裸 zh 不判定，維持站台原本的繁體預設', () => {
      const box = loadS2TLocale();
      assert.equal(box.__isSimplified('zh'), false, '無法區分繁簡時不應擅自開啟');
    });

    test('未傳入參數時應取用 navigator.language', () => {
      const cn = loadS2TLocale({ navigatorLanguage: 'zh-CN' });
      assert.equal(cn.__isSimplified(), true, '應讀取 navigator.language');

      const tw = loadS2TLocale({ navigatorLanguage: 'zh-TW' });
      assert.equal(tw.__isSimplified(), false, 'zh-TW 不應開啟');
    });

    test('navigator 不可用時應安全回傳 false，不得拋錯', () => {
      const sandbox = {
        STORAGE_KEYS: { AUTO_S2T: 'mdWebview-auto-s2t' },
        storage: { get: () => null, set: () => {} },
        Number, String, RegExp, console
      };
      vm.createContext(sandbox);
      const sig = 'function isSimplifiedChineseLocale(lang)';
      const code = `${sig} ${extractFunctionBody(appSource, sig)}\n` +
        'globalThis.__f = isSimplifiedChineseLocale;';
      vm.runInContext(code, sandbox);
      assert.equal(sandbox.__f(), false, '取不到 navigator 時應回傳 false');
    });
  });

  describe('自動開啟時機 maybeAutoEnableS2TFromLocale', () => {
    test('簡體中文 + 從未設定 → 應自動開啟並寫入 localStorage', () => {
      const box = loadS2TLocale({ navigatorLanguage: 'zh-CN', storedValue: null });
      const result = box.__maybeAuto();
      assert.equal(result, true, '應回報已自動開啟');
      assert.equal(
        box.storage._value, 'true',
        '必須寫入 localStorage，否則重新整理後又會回到關閉'
      );
    });

    test('繁體中文 + 從未設定 → 不得開啟', () => {
      const box = loadS2TLocale({ navigatorLanguage: 'zh-TW', storedValue: null });
      assert.equal(box.__maybeAuto(), false, '繁體使用者不應被自動開啟');
      assert.equal(box.storage._value, null, '不應寫入任何值');
    });

    test('使用者曾手動關閉 → 不得覆寫', () => {
      // 這是最關鍵的一條：若每次進站都依語言重新判斷，使用者手動關掉後
      // 下次進來又被打開，等於設定沒有作用。
      const box = loadS2TLocale({ navigatorLanguage: 'zh-CN', storedValue: 'false' });
      assert.equal(box.__maybeAuto(), false, '既有 false 設定必須被尊重');
      assert.equal(box.storage._value, 'false', '不得覆寫為 true');
    });

    test('使用者曾手動開啟 → 保持開啟', () => {
      const box = loadS2TLocale({ navigatorLanguage: 'zh-TW', storedValue: 'true' });
      assert.equal(box.__maybeAuto(), false, '已是 true 時無需重複動作');
      assert.equal(box.storage._value, 'true', '不得覆寫為 false');
    });

    test('localStorage 不可用時應安全失敗，不得中斷啟動', () => {
      const box = loadS2TLocale({ navigatorLanguage: 'zh-CN', storageThrows: true });
      assert.equal(box.__maybeAuto(), false, 'storage 異常時應回傳 false 而非拋錯');
    });
  });

  describe('初始化的執行順序', () => {
    test('必須在讀取 userAutoS2T 之前呼叫自動判斷', () => {
      // 若順序顛倒，state 會先套用舊值（null → false），
      // 自動開啟的結果就永遠進不到 state。
      const autoIdx = appSource.indexOf('maybeAutoEnableS2TFromLocale();');
      const readIdx = appSource.indexOf('const userAutoS2T = storage.get');
      assert.ok(autoIdx > 0, 'app.js 應呼叫 maybeAutoEnableS2TFromLocale()');
      assert.ok(readIdx > 0, 'app.js 應讀取 userAutoS2T');
      assert.ok(
        autoIdx < readIdx,
        `自動判斷（位置 ${autoIdx}）必須早於讀取 userAutoS2T（位置 ${readIdx}）`
      );
    });

    test('state.autoS2T 應以 localStorage 的值為準', () => {
      assert.match(
        appSource,
        /autoS2T:\s*userAutoS2T === 'true'/,
        'state.autoS2T 應反映 localStorage，使自動開啟的結果立即生效'
      );
    });
  });
});
