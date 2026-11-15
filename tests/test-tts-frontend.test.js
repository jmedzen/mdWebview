/**
 * 朗讀（TTS）前端的靜態檢查：無障礙語意、快捷鍵不攔截輸入框、Service Worker 的
 * 音檔快取不綁版本且支援 Range。播放邏輯本身在瀏覽器裡驗證（PR 附截圖），這裡只
 * 檢查容易在日後改動中被弄壞、而且影響 VoiceOver 讀者的部分。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

const playerHtml = html.slice(html.indexOf('<section class="tts-bar"'), html.indexOf('</section>', html.indexOf('<section class="tts-bar"')) + 10);
const ttsSection = app.slice(app.indexOf('§17c READ ALOUD'), app.indexOf('§18 READ PROGRESS'));

describe('朗讀播放器的無障礙語意', () => {
  test('播放列是有名稱的地標，並有「跳到朗讀播放器」略過連結', () => {
    assert.match(playerHtml, /^<section class="tts-bar" id="ttsBar" aria-label="朗讀播放器"/);
    assert.match(html, /<a class="tts-skip-link" id="ttsSkipLink" href="#ttsBar"/);
  });

  test('每顆圖示按鈕都有中文 aria-label；文字按鈕有可見文字', () => {
    const buttons = [...playerHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.ok(buttons.length >= 9);
    for (const [, attrs, inner] of buttons) {
      const label = /aria-label="([^"]+)"/.exec(attrs);
      const text = inner.replace(/<[^>]+>/g, '').trim();
      assert.ok((label && /[一-鿿]/.test(label[1])) || /[一-鿿×]/.test(text) || /id="ttsPlayBtn"/.test(attrs), `按鈕沒有名稱：${attrs}`);
    }
    // 播放鍵的名稱由程式依狀態切換（同一顆按鈕，不交替顯示兩顆）
    assert.match(ttsSection, /playBtn\.setAttribute\('aria-label', ttsRt\.playing \? '暫停' : '播放'\)/);
    assert.equal((playerHtml.match(/id="ttsPlayBtn"/g) || []).length, 1);
  });

  test('進度與語速是 slider，aria-valuetext 用中文說明（第 N 句、N 倍）', () => {
    assert.match(playerHtml, /<input type="range" id="ttsSeek"[^>]*aria-label="朗讀進度"/);
    assert.match(playerHtml, /<input type="range" id="ttsRate"[^>]*aria-label="語速"/);
    assert.match(ttsSection, /seek\.setAttribute\('aria-valuetext', `第 \$\{n\} 句，共/);
    assert.match(ttsSection, /rs\.setAttribute\('aria-valuetext', `\$\{rate\} 倍`\)/);
  });

  test('音色用原生 radio 組成的卡片（有試聽鈕）；展開鈕有 aria-expanded／aria-controls', () => {
    assert.match(playerHtml, /<div class="tts-voice-cards" id="ttsVoiceCards" role="radiogroup" aria-label="音色">/);
    assert.match(ttsSection, /<input type="radio" name="ttsVoice"/);
    assert.match(ttsSection, /aria-label="試聽\$\{escHtml\(v\.name\)\}"/);
    assert.match(playerHtml, /id="ttsExpandBtn" aria-expanded="false" aria-controls="ttsPanel"/);
  });

  test('只有一個 polite 的狀態區，而且只在使用者操作時寫入（不逐句報讀）', () => {
    assert.match(playerHtml, /id="ttsLive" role="status" aria-live="polite"/);
    const calls = [...ttsSection.matchAll(/ttsAnnounce\(/g)].length;
    assert.ok(calls >= 5);
    // ttsPlayAt（每換一句都會呼叫）裡面不能播報
    const playAt = ttsSection.slice(ttsSection.indexOf('async function ttsPlayAt'), ttsSection.indexOf('function ttsFail'));
    assert.ok(!/ttsAnnounce\(/.test(playAt), '換句時不得用 aria-live 播報');
  });

  test('標題後的「朗讀本節」是實體按鈕，名稱含標題文字；觸控下一直可見且至少 44pt', () => {
    assert.match(ttsSection, /b\.setAttribute\('aria-label', `朗讀本節：\$\{name\}`\)/);
    assert.match(ttsSection, /b\.type = 'button'/);
    assert.match(css, /@media \(hover: none\) \{[\s\S]*?\.tts-head-btn[\s\S]*?min-width: 44px; min-height: 44px;/);
  });

  test('朗讀中換一段新的（選字、朗讀本節）：馬上停掉正在播的舊句，ended 不會把新的第一句跳過', () => {
    const halt = ttsSection.slice(ttsSection.indexOf('function ttsHaltCurrent'), ttsSection.indexOf('async function ttsBegin'));
    assert.match(halt, /ttsRt\.token\+\+/);
    assert.match(halt, /clearTimeout\(ttsRt\.gapTimer\)/);
    assert.match(halt, /a\.dataset\.ttsSha = ''/);
    assert.match(halt, /a\.pause\(\)/);
    assert.ok(!/removeAttribute\('src'\)/.test(halt), '不清 src，iOS 解鎖保持有效');
    const begin = ttsSection.slice(ttsSection.indexOf('async function ttsBegin'));
    assert.ok(begin.indexOf('ttsHaltCurrent()') >= 0 && begin.indexOf('ttsHaltCurrent()') < begin.indexOf('ttsUnlock()'), '先停舊句再解鎖、再 await');
  });

  test('播放列的按鈕至少 44×44，播放列尊重 safe-area', () => {
    assert.match(css, /\.tts-btn \{[\s\S]*?width: 44px; height: 44px;/);
    assert.match(css, /\.tts-bar \{[\s\S]*?padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
  });

  test('prefers-reduced-motion 時不做動畫；forced-colors 有對應樣式', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tts-progress-fill/);
    assert.match(css, /@media \(forced-colors: active\) \{\s*\.tts-btn\.tts-play/);
    assert.match(ttsSection, /prefers-reduced-motion: reduce/);
  });

  test('跟讀高亮用獨立的 Highlight 名稱，不和劃重點衝突', () => {
    assert.match(css, /::highlight\(mdw-tts-current\)/);
    assert.match(ttsSection, /'mdw-tts-current'/);
    assert.ok(!/mdw-hl-/.test(ttsSection.replace(/hlSupported|hlRangeOf|hlOffsetOf/g, '')));
  });
});

describe('誦經模式、睡眠計時、離線下載', () => {
  const chantHtml = html.slice(html.indexOf('<div class="tts-chant"'), html.indexOf('<div class="tts-chant-foot"'));
  test('誦經模式是 aria-modal 的對話框；開啟時背景 inert、關閉時焦點回原處', () => {
    assert.match(html, /<div class="tts-chant" id="ttsChant" role="dialog" aria-modal="true" aria-labelledby="ttsChantTitle" hidden>/);
    const open = ttsSection.slice(ttsSection.indexOf('function openTtsChant'), ttsSection.indexOf('function closeTtsChant'));
    const close = ttsSection.slice(ttsSection.indexOf('function closeTtsChant'), ttsSection.indexOf('function renderTtsChant'));
    assert.match(open, /\.inert = true/); assert.match(open, /chantReturn = document\.activeElement/); assert.match(open, /\.focus\(\)/);
    assert.match(close, /\.inert = false/); assert.match(close, /back[\s\S]*\.focus\(\)/);
  });
  test('誦經模式的按鈕：播放 ≥ 64pt，其餘 ≥ 44pt，都有名稱；前後句不給 VoiceOver 重複讀', () => {
    assert.match(css, /\.tts-chant-btn\.tts-chant-play \{ width: 76px; height: 76px;/);
    assert.match(css, /\.tts-chant-btn \{\s*width: 56px; height: 56px;/);
    for (const id of ['ttsChantClose', 'ttsChantPrevBtn', 'ttsChantPlay', 'ttsChantNextBtn']) assert.match(chantHtml, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`));
    assert.match(chantHtml, /id="ttsChantPrev" aria-hidden="true"/);
    assert.match(chantHtml, /id="ttsChantNext" aria-hidden="true"/);
  });
  test('Esc 關閉誦經模式；焦點留在對話框內', () => {
    assert.match(ttsSection, /if \(e\.key === 'Escape' && ttsChantOpen\(\)\) \{ e\.preventDefault\(\); closeTtsChant\(\);/);
    assert.match(ttsSection, /if \(e\.key !== 'Tab'\) return; \/\/ 焦點留在對話框裡/);
  });
  test('睡眠計時：15／30／60 分與讀完本節；在換句時也檢查（背景時計時器會被凍結）', () => {
    for (const v of ['15', '30', '60', 'section']) assert.match(html, new RegExp(`<option value="${v}">`));
    const ended = ttsSection.slice(ttsSection.indexOf('async function onTtsEnded'), ttsSection.indexOf('function ttsFinish'));
    assert.match(ended, /ttsSleepCheck\(false\)/);
    assert.match(ended, /ttsRt\.sleep\.section && nx\.kind === 'heading'/);
  });
  test('離線下載存在獨立、不綁版本、不自動清理的快取；SW 先從那裡找', () => {
    assert.match(ttsSection, /const TTS_OFFLINE_CACHE = 'mdwebview-tts-offline-v1'/);
    assert.match(sw, /const TTS_OFFLINE_CACHE = 'mdwebview-tts-offline-v1'/);
    const handler = sw.slice(sw.indexOf('async function handleTtsAudio'));
    assert.ok(handler.indexOf('TTS_OFFLINE_CACHE') < handler.indexOf('cache.match(key)'));
    assert.ok(!/trimCache\(TTS_OFFLINE_CACHE/.test(sw));
  });
});

describe('第六階段：無障礙打磨', () => {
  test('經文區塊標上語言（繁體 zh-Hant、簡體 zh-Hans），誦經模式也是', () => {
    const fn = ttsSection.slice(ttsSection.indexOf('function syncTtsEntry'), ttsSection.indexOf('function ttsScheduleRepaint'));
    assert.match(fn, /isHansDisplay\(\) \? 'zh-Hans' : 'zh-Hant'/);
    assert.match(fn, /\$\('markdownBody'\)/); assert.match(fn, /\$\('ttsChantCurrent'\)/);
  });
  test('「讓 VoiceOver 焦點跟著目前的句子」預設關閉，移焦點時不捲動', () => {
    assert.match(ttsSection, /focusFollow: p\.focusFollow === true/);
    assert.match(ttsSection, /block\.focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /id="settingTtsFocusFollow"/);
  });
  test('偏好設定視窗有完整的朗讀區，每個欄位都有標籤', () => {
    const sec = html.slice(html.indexOf('<div class="tts-settings" id="ttsSettings">'), html.indexOf('<!-- Tab 2: 推薦經論'));
    for (const id of ['settingTtsVoice', 'settingTtsRate', 'settingTtsSleep']) assert.match(sec, new RegExp(`<label class="setting-item-label" for="${id}">`));
    for (const id of ['settingTtsFollow', 'settingTtsFocusFollow', 'settingTtsContinue', 'settingTtsShortcuts']) assert.match(sec, new RegExp(`for="${id}" title="[^"]+"`));
  });
  test('大綱每一列也有「朗讀本節」，名稱用標題文字', () => {
    assert.match(ttsSection, /b\.className = 'toc-tts-btn'/);
    assert.match(ttsSection, /row\.querySelector\('\.toc-item-label'\)/);
    assert.match(css, /@media \(hover: none\) \{ body\.tts-enabled \.toc-tts-btn \{ opacity: 0\.8; width: 44px; height: 44px; \} \}/);
  });
  test('Media Session 的播放／暫停（耳機、控制中心、VoiceOver 兩指點兩下）都接上', () => {
    for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'stop']) assert.match(ttsSection, new RegExp(`bind\\('${a}'`));
  });
});

describe('朗讀的配色對比（WCAG AA）', () => {
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const themeVar = (theme, name) => {
    const block = new RegExp(`\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\}`).exec(css)[1];
    return new RegExp(`--${name}: (#[0-9a-fA-F]{6})`).exec(block)[1];
  };
  const ttsVar = (dark, name) => {
    const block = dark
      ? /\/\* =+\s*§27c[\s\S]*?\[data-theme="obsidian-dark"\],\s*\[data-theme="solarized"\],\s*\[data-theme="gruvbox"\] \{([\s\S]*?)\}/.exec(css)[1]
      : /\/\* =+\s*§27c[\s\S]*?:root \{([\s\S]*?)\}/.exec(css)[1];
    return new RegExp(`--${name}: (#[0-9a-fA-F]{6})`).exec(block)[1];
  };

  for (const theme of ['paper', 'moon', 'bamboo', 'obsidian-light', 'zen']) {
    test(`${theme}：朱色文字 ≥ 4.5:1、朱色圖形 ≥ 3:1`, () => {
      const bg = themeVar(theme, 'bg-secondary');
      assert.ok(ratio(ttsVar(false, 'tts-accent-text'), bg) >= 4.5, `${theme} 文字對比不足`);
      assert.ok(ratio(ttsVar(false, 'tts-accent'), bg) >= 3, `${theme} 控制元件對比不足`);
      assert.ok(ratio(ttsVar(false, 'tts-on-accent'), ttsVar(false, 'tts-accent')) >= 4.5, '播放鍵圖示對比不足');
    });
  }
  for (const theme of ['obsidian-dark', 'solarized', 'gruvbox']) {
    test(`${theme}：朱色文字 ≥ 4.5:1`, () => {
      const bg = themeVar(theme, 'bg-secondary');
      assert.ok(ratio(ttsVar(true, 'tts-accent-text'), bg) >= 4.5);
      assert.ok(ratio(ttsVar(true, 'tts-on-accent'), ttsVar(true, 'tts-accent')) >= 4.5);
    });
  }
});

describe('朗讀的鍵盤快捷鍵', () => {
  const handler = ttsSection.slice(ttsSection.indexOf("document.addEventListener('keydown'"), ttsSection.indexOf("document.addEventListener('visibilitychange'"));

  test('只用 Alt，不碰 Ctrl／Cmd（VoiceOver 的修飾鍵是 Ctrl+Option）', () => {
    assert.match(handler, /if \(!e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey/);
  });

  test('在輸入框內不生效；可在偏好中關閉', () => {
    assert.match(handler, /isTtsTypingTarget\(e\.target\)/);
    assert.match(handler, /ttsPrefs\(\)\.shortcuts/);
    const fn = ttsSection.slice(ttsSection.indexOf('function isTtsTypingTarget'), ttsSection.indexOf('function setupTts()'));
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT', 'isContentEditable']) assert.ok(fn.includes(t), t);
  });

  test('用 e.code 判斷（Mac 的 Option+R 會打出 ®）', () => {
    assert.match(handler, /e\.code === 'KeyR'/);
  });
});

describe('Service Worker 的朗讀音檔快取', () => {
  test('快取名稱不綁 app 版本，升版時不會被清掉', () => {
    const name = /const TTS_CACHE = '([^']+)'/.exec(sw)[1];
    assert.ok(!name.includes('${') && !name.includes('__APP_VERSION__'));
    const activate = sw.slice(sw.indexOf("addEventListener('activate'"), sw.indexOf("addEventListener('fetch'"));
    assert.match(activate, /key\.startsWith\('mdwebview-shell-'\) \|\| key\.startsWith\('mdwebview-content-'\)/);
    assert.ok(!name.startsWith('mdwebview-shell-') && !name.startsWith('mdwebview-content-'));
  });

  test('朗讀音檔在 /api/ 的 network-only 規則之前處理', () => {
    const fetchH = sw.slice(sw.indexOf("addEventListener('fetch'"));
    assert.ok(fetchH.indexOf('TTS_AUDIO_PREFIX') < fetchH.indexOf("url.pathname.startsWith('/api/')"));
  });

  test('parseTtsRange 與伺服器的 parseByteRange 行為一致', () => {
    const src = sw.slice(sw.indexOf('function parseTtsRange'), sw.indexOf('async function ttsRangeResponse'));
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.parseTtsRange = parseTtsRange;', ctx);
    const { parseByteRange } = require('../lib/utils.js');
    for (const h of ['bytes=0-99', 'bytes=900-', 'bytes=-100', 'bytes=-5000', 'bytes=990-5000', 'bytes=1000-', 'bytes=-0', 'bytes=5-2', 'garbage', '', 'bytes=0-1,5-9']) {
      assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseTtsRange(h, 1000))), parseByteRange(h, 1000), h);
    }
  });
});
