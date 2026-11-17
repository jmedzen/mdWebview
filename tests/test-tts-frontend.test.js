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

  test('標題旁的「朗讀本節」是實體按鈕，名稱含標題文字；放在標題外面、浮動不佔一行；點擊範圍至少 44pt', () => {
    assert.match(ttsSection, /b\.setAttribute\('aria-label', `朗讀本節：\$\{name\}`\)/);
    assert.match(ttsSection, /b\.type = 'button'/);
    // 放在標題前面當兄弟元素：標題的無障礙名稱不會混進「朗讀本節」
    assert.match(ttsSection, /h\.before\(b\)/);
    assert.ok(!/h\.appendChild\(b\)/.test(ttsSection), '按鈕不可放進標題裡');
    assert.match(ttsSection, /ttsHeadingLine\(b\.nextElementSibling\)/);
    const rule = css.match(/body\.tts-enabled \.markdown-body \.tts-head-btn \{[^}]*\}/);
    assert.ok(rule, '找不到按鈕樣式');
    assert.match(rule[0], /float: right;/);
    assert.match(rule[0], /width: var\(--tts-head-size\); height: var\(--tts-head-size\);/);
    // 大小跟著所在標題的字級
    for (const [h, em] of [['h1', '1.75'], ['h2', '1.45'], ['h3', '1.2'], ['h4', '1.05']]) {
      assert.match(css, new RegExp(`\\.tts-head-btn:has\\(\\+ ${h}\\) \\{ font-size: ${em}em; \\}`), h);
    }
    // 點擊範圍：::after 補到至少 44px
    assert.match(css, /\.tts-head-btn::after \{\s*content: ''; position: absolute; inset: min\(-4px, calc\(\(var\(--tts-head-size\) - 44px\) \/ 2\)\);/);
    assert.match(css, /@media \(hover: none\) \{[\s\S]*?\.tts-head-btn[\s\S]*?opacity: 0\.9;/);
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

  test('展開面板只放音色、語速、聆聽方式；其他偏好集中在偏好設定的「朗讀」分頁（不重複）', () => {
    assert.match(playerHtml, /<input type="checkbox" id="ttsPinVoice" role="switch">/);
    for (const id of ['ttsContinueNext', 'ttsFollow', 'ttsExact', 'ttsShortcuts', 'ttsSelContinue', 'ttsMore', 'ttsStopBtn', 'ttsSeekTotal']) {
      assert.doesNotMatch(playerHtml, new RegExp(`id="${id}"`), `${id} 已移出面板`);
      assert.doesNotMatch(ttsSection, new RegExp(`\\$\\('${id}'\\)`), `${id} 不再被程式引用`);
    }
    assert.match(playerHtml, /id="ttsMoreBtn"[^>]*>[\s\S]*?更多朗讀設定/);
    assert.match(ttsSection, /on\('ttsMoreBtn', 'click'[^\n]*settingsTab-tts/);
    const pane = html.slice(html.indexOf('id="pane-tts"'), html.indexOf('<!-- Tab 2: 推薦經論'));
    for (const id of ['settingTtsContinue', 'settingTtsFollow', 'settingTtsShortcuts', 'settingTtsSelContinue', 'settingTtsExact', 'settingTtsSleep']) assert.match(pane, new RegExp(`id="${id}"`), id);
    assert.match(html, /data-tab="tts" id="settingsTab-tts" role="tab" aria-controls="pane-tts">🔊 朗讀</);
    assert.match(css, /body:not\(\.tts-enabled\) \.tts-settings-tab \{ display: none; \}|body:not\(\.tts-enabled\) #ttsSettings, body:not\(\.tts-enabled\) \.tts-settings-tab \{ display: none; \}/);
    // 同一件事全站同一句話
    assert.equal((html.match(/大字全螢幕，跟著念/g) || []).length, 2);
    assert.doesNotMatch(html, /大字全螢幕跟讀|讀完這一篇，接著讀/);
    assert.match(playerHtml, /<select id="ttsSleep"[^>]*aria-label="睡眠計時"/);
    assert.match(playerHtml, /id="ttsOfflineBtn" aria-label="下載整篇以離線收聽"/);
    assert.match(css, /\.tts-voice-name \{[^}]*overflow-wrap: anywhere;/);
    assert.match(css, /\.tts-voice-tags \{[^}]*color: var\(--text-secondary\);/);
    assert.match(css, /\.tts-voice-card \{[^}]*min-height: 44px;/);
  });

  test('音色顯示名：去掉 Ref-Audio-male- 這類檔名前綴，中文名不動', () => {
    const src = ttsSection.slice(ttsSection.indexOf('function tidyTtsVoiceName'), ttsSection.indexOf('async function refreshTtsStatus'));
    const ctx = { String }; vm.createContext(ctx);
    vm.runInContext(src + '\nthis.t = tidyTtsVoiceNames;', ctx);
    const run = (names) => { const l = names.map(name => ({ name })); ctx.t(l); return l.map(x => x.name); };
    assert.deepEqual(run(['Ref-Audio-male-都A1', 'Ref-Audio-male-馬克思1']), ['都A1', '馬克思1']);
    assert.deepEqual(run(['RA-male-都A1', 'RA-male-雙子男']), ['都A1', '雙子男']);
    assert.deepEqual(run(['男聲・都', '男聲・馬']), ['男聲・都', '男聲・馬']);
    assert.deepEqual(run(['demo_1_man', 'demo_3_woman']), ['demo_1_man', 'demo_3_woman']);
  });

  test('朗讀選取後預設繼續往下讀（可關）：選的句子讀完就接上後面的句子', () => {
    assert.match(ttsSection, /selContinue: p\.selContinue !== false/);
    assert.match(html, /<input type="checkbox" id="settingTtsSelContinue">/);
    assert.match(ttsSection, /prefChk\('settingTtsSelContinue', 'selContinue'\)/);
    const ended = ttsSection.slice(ttsSection.indexOf('async function onTtsEnded'), ttsSection.indexOf('function ttsFinish'));
    assert.match(ended, /ttsPrefs\(\)\.selContinue/);
    assert.ok(ended.indexOf('ttsContinueAfterSelection(token)') < ended.indexOf('ttsContinueNextDoc()'), '先接本篇後面的句子，才考慮下一篇');
    const cont = ttsSection.slice(ttsSection.indexOf('async function ttsContinueAfterSelection'), ttsSection.indexOf('async function onTtsEnded'));
    assert.match(cont, /x\.i > last\.i/);
    assert.match(cont, /ttsRt\.endIndex = -1/);
  });

  test('右上角喇叭是朗讀選單（menu button）：所有啟動方式＋朗讀本句（讀完就停）', () => {
    assert.match(html, /id="ttsStartBtn"[^>]*aria-label="朗讀選單" aria-haspopup="menu" aria-expanded="false" aria-controls="ttsStartMenu"/);
    assert.match(html, /<div class="tts-menu" id="ttsStartMenu" role="menu" aria-label="朗讀" hidden>/);
    for (const act of ['here', 'section', 'sentence', 'top', 'chant', 'panel', 'next', 'sleep', 'toggle']) {
      assert.match(html, new RegExp(`data-tts-act="${act}"`), act);
    }
    assert.match(html, /role="menuitemcheckbox"[^>]*data-tts-act="next"/);
    assert.match(html, /role="menuitemradio"[^>]*data-sleep="section"/);
    // 朗讀本句：選取＝只讀選取（selOnly，不接後面）；沒選取＝畫面上第一句（endIndex＝那一句）
    assert.match(ttsSection, /ttsStartFromSelection\(range, \{ only: true \}\)/);
    assert.match(ttsSection, /if \(opts && opts\.one && first >= 0\) ttsRt\.endIndex = first;/);
    assert.match(ttsSection, /ttsRt\.selFrom >= 0 && !ttsRt\.selOnly && ttsPrefs\(\)\.selContinue/);
    // 鍵盤：↑↓／Home／End／Esc；Esc 把焦點還給按鈕
    const setup = ttsSection.slice(ttsSection.indexOf('function setupTtsStartMenu'), ttsSection.indexOf('function ttsHeadingLine'));
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) assert.ok(setup.includes(`'${k}'`), k);
    assert.match(css, /\.tts-menu-item \{[^}]*min-height: 44px;/);
    assert.match(css, /\.tts-menu-chip \{[^}]*min-height: 44px;/);
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

describe('離線下載的限流重試', () => {
  test('整篇下載撞到 429 時等一下再試，不直接算失敗', () => {
    const dl = ttsSection.slice(ttsSection.indexOf('async function ttsDownloadOffline'), ttsSection.indexOf('async function ttsEnsureFor'));
    assert.match(dl, /if \(res\.status !== 429\) break;/);
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
    for (const t of ['INPUT', 'TEXTAREA', 'isContentEditable']) assert.ok(fn.includes(t), t);
  });

  test('勾選框、滑桿不算打字欄位（剛按完面板裡的勾選框也要能用快捷鍵）；Mac 顯示 ⌥', () => {
    const src = ttsSection.slice(ttsSection.indexOf('const TTS_TEXT_INPUT'), ttsSection.indexOf('function localizeTtsShortcutLabels'));
    // Chromium 的 userAgentData.platform 是小寫開頭的「macOS」
    const ctx = { navigator: { userAgentData: { platform: 'macOS' } }, String }; vm.createContext(ctx);
    vm.runInContext(src.replace(/const /g, 'var ') + '\nthis.f = isTtsTypingTarget; this.l = ttsKeyLabel;', ctx);
    const el = (tagName, type, extra) => Object.assign({ tagName, type }, extra || {});
    assert.equal(ctx.f(el('INPUT', 'checkbox')), false);
    assert.equal(ctx.f(el('INPUT', 'range')), false);
    assert.equal(ctx.f(el('SELECT')), false);
    assert.equal(ctx.f(el('BUTTON')), false);
    assert.equal(ctx.f(el('INPUT', 'text')), true);
    assert.equal(ctx.f(el('INPUT', 'search')), true);
    assert.equal(ctx.f(el('TEXTAREA')), true);
    assert.equal(ctx.f(el('DIV', undefined, { isContentEditable: true })), true);
    assert.equal(ctx.l('播放（Alt+R）'), '播放（⌥R）');
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

describe('上一句／下一句', () => {
  test('暫停中或已讀完時按上一句／下一句也會開始播那一句；到頭時有看得到的提示', () => {
    const fn = ttsSection.slice(ttsSection.indexOf('async function ttsStep'), ttsSection.indexOf('function ttsStop'));
    assert.match(fn, /ttsUnlock\(\);\s*let k = /, '解鎖要在第一個 await 之前');
    assert.match(fn, /ttsRt\.playing = true;/);
    assert.match(fn, /showToast\(msg/);
  });
});

describe('等待與失敗（2026-11-16 體驗審計第一批）', () => {
  test('解鎖用的靜音檔開始播放時，不清掉「生成中」的等待狀態', () => {
    const m = /a\.addEventListener\('playing', \(\) => \{([^\n]*)\}\);/.exec(ttsSection);
    assert.ok(m, '找不到 playing 事件');
    assert.match(m[1], /^\s*if \(!a\.dataset\.ttsSha\) return;/);
  });

  test('等太久顯示暖機提示；失敗先自動重試再略過，連續失敗才停', () => {
    assert.match(ttsSection, /const TTS_SLOW_WAIT_MS = \d+;/);
    const retry = /const TTS_RETRY_MS = \[([^\]]+)\]/.exec(ttsSection)[1].split(',').map(Number);
    assert.ok(retry.reduce((a, b) => a + b, 0) > 30000, '最後一次重試要等過伺服器 30 秒的失敗記憶');
    const rec = ttsSection.slice(ttsSection.indexOf('function ttsRecover'), ttsSection.indexOf('async function ttsEnsure'));
    assert.match(rec, /ttsRt\.failStreak >= 3/);
    assert.match(rec, /ttsPlayAt\(next\)/);
    const playAt = ttsSection.slice(ttsSection.indexOf('async function ttsPlayAt'), ttsSection.indexOf('function ttsFail'));
    assert.match(playAt, /ttsRecover\(k, /);
  });

  test('訪客不能生成時：錯誤列顯示「登入後繼續」（不是無效的重試），登入後接著讀', () => {
    assert.match(html, /id="ttsLoginBtn" hidden>登入後繼續<\/button>/);
    assert.match(ttsSection, /retry\.hidden = !ttsRt\.error \|\| needLogin;/);
    assert.match(ttsSection, /openAccountAuth\('login', \{ afterLogin: 'tts' \}\)/);
    assert.match(app, /authUi\.afterLogin === 'tts'[\s\S]{0,80}ttsResumeAfterLogin\(\)/);
  });
});

describe('長時間聽經（2026-11-16 體驗審計第二批）', () => {
  test('切到背景時預取擴大到約 2 分鐘，並分批（伺服器一次最多 8 句）', () => {
    const fn = ttsSection.slice(ttsSection.indexOf('function ttsPrefetch'), ttsSection.indexOf('function ttsItemChars'));
    assert.match(fn, /document\.visibilityState === 'hidden'/);
    assert.match(fn, /TTS_BG_AHEAD_MS/);
    assert.match(fn, /need\.slice\(i, i \+ 8\)/);
    assert.match(ttsSection, /if \(document\.visibilityState === 'hidden' && ttsRt\.active && ttsRt\.playing && ttsRt\.pos >= 0\) ttsPrefetch\(ttsRt\.pos\);/);
  });

  test('一般經文記住上次位置：選單「從上次位置繼續」、首頁「繼續聽」；整篇讀完才清掉', () => {
    assert.match(html, /data-tts-act="resume" hidden>/);
    assert.match(html, /id="homeResume" hidden>/);
    assert.match(ttsSection, /if \(ttsRt\.listen\) listenOnPlay\(it\); else ttsSaveResume\(it\);/);
    assert.match(ttsSection, /ttsClearResume\(ttsRt\.path\)/);
    const home = ttsSection.slice(ttsSection.indexOf('async function ttsResumeFromHome'));
    assert.match(home.slice(0, 300), /ttsUnlock\(\);\s*try \{ if \(state\.currentFile/, '解鎖要在 await 之前（iOS）');
  });

  test('播放列顯示剩下的時間（依語速），總句數未定時不顯示「57+」', () => {
    assert.match(ttsSection, /function ttsRemainingMs\(\)/);
    assert.match(ttsSection, /return ms \/ \(ttsRate\(\) \|\| 1\);/);
    assert.match(ttsSection, /open && remain \? '' :/);
  });
});

describe('入口與互動（2026-11-16 體驗審計第三批）', () => {
  test('右上角只有一顆喇叭：一按就開選單（沒有 ▾），原本的「從這裡讀／暫停」是選單第一項', () => {
    assert.doesNotMatch(html, /id="ttsQuickBtn"/);
    assert.doesNotMatch(html, /tts-caret-btn/);
    assert.doesNotMatch(ttsSection, /ttsQuickBtn/);
    const btn = html.match(/<button id="ttsStartBtn"[\s\S]*?<\/button>/)[0];
    assert.match(btn, /aria-haspopup="menu" aria-expanded="false" aria-controls="ttsStartMenu"/);
    assert.match(btn, /<path d="M2\.5 6\.2v3\.6h2\.4L8\.2 12\.6V3\.4L4\.9 6\.2z"\/>/, '喇叭圖示');
    const menu = html.slice(html.indexOf('id="ttsStartMenu"'));
    const acts = [...menu.matchAll(/data-tts-act="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(acts.slice(0, 3), ['toggle', 'here', 'resume'], '朗讀中第一項是暫停／繼續；沒在讀時第一項是從這裡讀');
    assert.match(ttsSection, /const label = `朗讀選單\$\{st\}`;/);
    assert.match(ttsSection, /btn\.addEventListener\('click', \(\) => \{ hideTtsHint\(true\); if \(menu\.hidden\)/);
    assert.match(ttsSection, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeTtsStartMenu\(true\);/);
    assert.match(ttsSection, /if \(e\.code === 'KeyR'\) \{ e\.preventDefault\(\); if \(state\.currentFile \|\| ttsRt\.active\) ttsTogglePlay\(\); \}/, 'Alt+R 仍可直接開始／暫停');
  });

  test('播放中點段落出現「從這段讀」；不攔截連結、按鈕與選字', () => {
    assert.match(html, /id="ttsJumpPill" hidden>從這段讀<\/button>/);
    assert.match(ttsSection, /e\.target\.closest\('a, button, input, select, textarea, label, summary, sup, \.tts-head-btn'\)/);
    assert.match(ttsSection, /if \(sel && !sel\.isCollapsed\) return;/);
  });

  test('「這句念錯了」只送路徑與句子序號（文字由伺服器取）', () => {
    assert.match(html, /id="ttsReportBtn" aria-expanded="false" aria-controls="ttsReportForm">這句念錯了<\/button>/);
    assert.match(ttsSection, /ttsApi\('\/api\/tts\/report', \{ path: ttsRt\.path, i: it\.i, voice: v && v\.id, note: /);
  });

  test('首次提示只出現一次，按過喇叭或「知道了」就不再出現', () => {
    assert.match(html, /<div class="tts-hint" id="ttsHint" role="note" hidden>/);
    assert.match(ttsSection, /if \(storage\.get\(TTS_HINT_KEY\)\) return;/);
  });

  test('播放列標題去掉藏經編號與書名號；音色鈕只放主名', () => {
    const grab = name => { const m = ttsSection.match(new RegExp(`function ${name}\\(name\\) \\{[\\s\\S]*?\\n  \\}`)); assert.ok(m, name); return new Function(`${m[0]}; return ${name};`)(); };
    const clean = grab('ttsCleanTitle');
    assert.equal(clean('T0412《地藏菩薩本願經》'), '地藏菩薩本願經');
    assert.equal(clean('X1234_楞嚴經'), '楞嚴經');
    assert.equal(clean('2026年度報告'), '2026年度報告');
    assert.equal(clean('T0235'), 'T0235');
    const short = grab('ttsVoiceShortName');
    assert.equal(short('慧音（女聲・柔和）'), '慧音');
    assert.match(ttsSection, /ttsRt\.title = ttsCleanTitle\(/);
  });
});

describe('2026-11-17 介面審計修正（讀者端）', () => {
  test('手機最窄時播放列一定留著停止鍵（語速改在面板）；面板不再有第二顆「停止朗讀」', () => {
    assert.doesNotMatch(css, /#ttsCloseBtn \{ display: none; \}/);
    assert.match(css, /@media \(max-width: 380px\) \{[^}]*\}[^@]*#ttsRateBtn \{ display: none; \}/);
    assert.doesNotMatch(html, /tts-stop-btn/);
  });
  test('語速全站寫成「1 倍」；面板進度列下方不重複剩餘時間', () => {
    assert.match(html, /id="ttsRateBtn">1 倍</);
    assert.match(ttsSection, /rateBtn\.textContent = `\$\{rate\} 倍`;/);
    assert.match(html, /<span class="tts-seek-now" id="ttsSeekNow" aria-hidden="true"><\/span>/);
  });
  test('手機「回到朗讀位置」浮在播放列上方，不擠經名', () => {
    assert.match(css, /#ttsBackBtn \{ position: absolute; left: 50%; bottom: calc\(100% \+ 10px\);/);
  });
  test('誦經模式的進度與播放列一致（剩餘時間，不顯示「+」）', () => {
    const fn = ttsSection.slice(ttsSection.indexOf("$('ttsChantMeta')") - 200, ttsSection.indexOf("$('ttsChantMeta')") + 300);
    assert.match(fn, /const remain = ttsFmtRemain\(ttsRemainingMs\(\)\);/);
    assert.match(fn, /open && remain \? ''/);
  });
  test('選字工具列有朗讀時排六欄；右上角喇叭觸控範圍 44px；聽經標題不畫焦點框；字級至少 12px', () => {
    assert.match(css, /body\.tts-enabled \.selection-share-popup\.touch:not\(\.hl-edit\) \.sel-actions \{ grid-template-columns: repeat\(6, 1fr\); \}/);
    assert.match(css, /@media \(hover: none\) \{ \.header-right \.tts-start-btn::after \{ content: ''; position: absolute; inset: -8px -3px; \} \}/);
    assert.match(css, /#listenTitle:focus \{ outline: none; \}/);
    for (const c of ['tts-voice-tags', 'tts-row-sub', 'tts-menu-sub']) assert.match(css, new RegExp(`\\.${c} \\{ font-size: max\\(12px,`), c);
  });
  test('「從這段讀」寬螢幕放在段落左邊空白，不蓋住經文', () => {
    assert.match(ttsSection, /if \(br\.left - w - 12 >= minLeft\)/);
  });
});


describe('2026-11-17 介面審計修正（後台）', () => {
  test('聽經目錄的「整個目錄」只有一個入口：朗讀頁的 🎧 區；用詞統一為「釘選」', () => {
    assert.doesNotMatch(app, /data-lc-act="gen-all"/);
    assert.match(app, /data-lc-act="goto-gen-all"/);
    assert.match(app, /if \(act === 'goto-gen-all'\)[\s\S]{0,400}adminTtsLcGenTitle/);
    assert.doesNotMatch(app, /固定保留/);
    assert.match(app, /id="lcGenPin" checked data-no-dirty> 釘選（不被自動清除）/);
  });
  test('手機音色表改成卡片：每格有 data-label，600px 以下不靠橫向捲動', () => {
    for (const lab of ['開放', '預設', '名稱', '中文名', '標籤', '預設語速', '版本', '試聽']) assert.match(app, new RegExp(`<td data-label="${lab}">`), lab);
    assert.match(css, /@media \(max-width: 600px\) \{\n  \.admin-shell #adminTtsVoices, \.admin-shell #adminTtsVoices tbody \{ display: block; \}/);
    assert.match(css, /#adminTtsVoices tr\[data-voice\] > td:nth-child\(3\) \{ order: -1; flex: 1 1 100%;/);
  });
  test('讀音校正：讀者回報排在最前面並顯示待處理數，內建表放最後；「生效」用綠色', () => {
    const card = html.slice(html.indexOf('data-card="ttslexicon"'), html.indexOf('data-card="ttscache"'));
    const at = (t) => card.indexOf(t);
    assert.ok(at('id="adminTtsReports"') < at('id="adminTtsLexicon"') && at('id="adminTtsLexicon"') < at('id="adminTtsBuiltinTable"'));
    assert.match(card, /id="adminTtsReportCount" hidden/);
    assert.match(css, /\.tts-lex-state\.on \{ background: var\(--success-bg\); color: var\(--success\); \}/);
  });
  test('後台下拉一致樣式；開關有關聯的名稱；預先生成的釘選獨立一行', () => {
    assert.match(css, /#adminTtsModel,\n#adminTtsAsrModel,\n#adminTtsJobVoice \{/);
    for (const id of ['adminTtsEnabled', 'adminTtsAutoTranscribe', 'adminTtsBuiltinLexicon']) assert.match(html, new RegExp(`id="${id}" aria-labelledby="${id}Title"`), id);
    assert.match(html, /id="adminTtsJobAddBtn" data-no-dirty>開始<\/button>\n\s*<\/div>\n\s*<label class="tts-lcgen-check tts-job-pin"><input type="checkbox" id="adminTtsJobPin"/);
  });
});

describe('後台：開放的音色都找不到錄音時要警告', () => {
  const start = app.indexOf('function ttsAdminUsableVoices(');
  const src = app.slice(start, app.indexOf('\n  }\n', start) + 4);
  const ctx = { Array, Set }; vm.createContext(ctx);
  vm.runInContext(src + '\nthis.f = ttsAdminUsableVoices;', ctx);
  const voices = [{ voice: 'RA-male-都A1', enabled: true }, { voice: 'RA-male-雙子男', enabled: true }, { voice: 'RA-m-米陸', enabled: false }];

  test('白名單的錄音都已改名或刪除 → 讀者端沒有可用音色', () => {
    assert.equal(ctx.f({ settings: { voices }, upstreamVoices: ['RA-m-米陸', 'RA-f-芙蓉'] }).length, 0);
  });
  test('還有錄音的已開放音色才算；不知道 audio.cpp 清單時不誤報', () => {
    assert.equal(ctx.f({ settings: { voices }, upstreamVoices: ['RA-male-都A1'] }).length, 1);
    assert.equal(ctx.f({ settings: { voices }, upstreamVoices: null }).length, 2);
  });
  test('狀態燈在這種情況亮紅燈並說明入口已隱藏', () => {
    assert.match(app, /else if \(!ttsAdminUsableVoices\(d\)\.length\) setAdminCardLight\('tts', 'bad', '[^']*讀者端的朗讀入口已全部隱藏/);
  });
});
