/**
 * share-card.js — 每日經句「早安圖」分享卡的繪圖程式（瀏覽器與伺服器共用）
 *
 * 同一份程式：
 *   - 伺服器（lib/share-card-render.js）用 @napi-rs/canvas 畫，給 LINE 連結預覽（og:image）與分享面板用；
 *   - 瀏覽器在伺服器不能畫圖時（沒裝套件）用 <canvas> 畫，當備援。
 * 只用兩邊都有的 Canvas 2D API（不用 letterSpacing、filter），字距、直書都自己一個字一個字畫。
 *
 * 三種版型：
 *   A 晨光留白：圖在上，往下淡成紙色，深墨色字寫在紙上（任何背景都清楚）
 *   B 沉浸全幅：圖片滿版，下方墨色漸層，白字；漸層深淺依圖片下半部的亮度自動調整
 *   C 經籤直書：圖片滿版，中間一張直書經籤，紅字問候與印章
 * 兩種尺寸：portrait（直接傳圖）、og 1200×630（連結預覽）。
 *   版面一律以 SIZES 的座標畫（直式 1080×1350）；實際畫布用 PIXEL_SIZES（直式放大 1.5 倍 = 1620×2025），
 *   draw() 依畫布寬度自動縮放，QR 小籤在實際像素上畫整數格才銳利。
 * QR 碼（原文連結）：opts.qr = 網址字串，只畫在直式上；QR 產生器是 vendor/qrcode/qrcode.js（MIT），
 *   瀏覽器要先載入（全域 qrcode），伺服器用 require 自動載入。
 */
(function (root, factory) {
  let qrLib = root && root.qrcode;
  if (!qrLib && typeof require === 'function') {
    try { qrLib = require('./vendor/qrcode/qrcode.js'); } catch (_) { qrLib = null; }
  }
  const api = factory(() => qrLib || (root && root.qrcode) || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShareCard = api;
})(typeof self !== 'undefined' ? self : this, function (getQrLib) {
  'use strict';

  // 底色（紙色）：紙底版型（A/I/J/N/P/Q）共用一組配色；B/C 是滿版圖、QR 小籤固定米色，不跟著換。
  // 每組：top/bottom = 紙色上下漸層，rgb = top 的 r,g,b（圖片淡入紙色用），
  // ink = 經句與大字，inkSoft = 日期，source = 出處，muted = 頁尾站名，gold = 細金線，rule = 分隔線，
  // tag* = 版型 C 經籤（半透明底、經句、日期與出處、金框的 r,g,b），red = 紅字問候（J、C），grain = 紙紋細點顏色。紅印（#b8322a）與金箔漸層在每種底色上都清楚，不換。
  const BASES = {
    cream: { name: '奶油', top: '#f6f0e2', bottom: '#efe6d0', rgb: '246,240,226',
      ink: '#231e18', inkSoft: '#6b5d46', source: '#8b7248', muted: '#8b7d68', gold: '#b8932f', rule: '#d9ccb2', red: '#9c2f27', grain: '#8a7550',
      tag: '252,248,238', tagInk: '#2a2620', tagSoft: '#7a6a52', tagLine: '176,141,74' },
    moon: { name: '月白', top: '#eef2f2', bottom: '#dfe7e8', rgb: '238,242,242',
      ink: '#1c2629', inkSoft: '#4c5e63', source: '#5b6f70', muted: '#728186', gold: '#a8893e', rule: '#c5d1d3', red: '#9c2f27', grain: '#56707a',
      tag: '246,249,249', tagInk: '#1c2629', tagSoft: '#4c5e63', tagLine: '168,137,62' },
    bamboo: { name: '竹青', top: '#eaf1de', bottom: '#dbe6cb', rgb: '234,241,222',
      ink: '#1b2614', inkSoft: '#46563a', source: '#566a43', muted: '#687a55', gold: '#a8903c', rule: '#c4d3ae', red: '#9c2f27', grain: '#4f6a3a',
      tag: '245,250,238', tagInk: '#1b2614', tagSoft: '#46563a', tagLine: '150,160,70' },
    plain: { name: '素紙', top: '#f7f7f4', bottom: '#eaeae5', rgb: '247,247,244',
      ink: '#1f1f1f', inkSoft: '#57554f', source: '#6e675a', muted: '#86837b', gold: '#a88a48', rule: '#d6d4cc', red: '#9c2f27', grain: '#6e6a60',
      tag: '252,252,250', tagInk: '#1f1f1f', tagSoft: '#57554f', tagLine: '168,138,72' }
  };
  const BASE_IDS = Object.keys(BASES);
  const BASE_NAMES = Object.fromEntries(BASE_IDS.map(k => [k, BASES[k].name]));
  // 每種底色可用的版型：B（沉浸全幅）只給奶油；K 圓月＝月白、L 卷軸＝竹青、M 裱框＝素紙 各自專屬。
  const COMMON_LAYOUTS = ['A', 'C', 'I', 'J', 'N', 'P', 'Q'];
  const BASE_LAYOUTS = {
    cream: ['A', 'B', 'C', 'I', 'J', 'N', 'P', 'Q'],
    moon: COMMON_LAYOUTS.concat('K'),
    bamboo: COMMON_LAYOUTS.concat('L'),
    plain: COMMON_LAYOUTS.concat('M')
  };
  function layoutsFor(base) { return BASE_LAYOUTS[normalizeBase(base)].slice(); }
  /** 該底色不能用的版型（例如月白底的 B）退回 A。 */
  function layoutFor(layout, base) {
    const l = normalizeLayout(layout);
    return BASE_LAYOUTS[normalizeBase(base)].includes(l) ? l : 'A';
  }
  // 舊名 apricot（竹青）已換成 bamboo（竹青）；舊連結與本機設定照樣對得上
  function normalizeBase(b) { let k = String(b || '').toLowerCase(); if (k === 'apricot') k = 'bamboo'; return BASE_IDS.includes(k) ? k : 'cream'; }
  // 目前這張卡的配色（draw() 開頭設定、結束還原；畫圖是同步的，不會互相干擾）
  let T = BASES.cream;

  const LAYOUTS = ['A', 'B', 'C', 'I', 'J', 'N', 'P', 'Q', 'K', 'L', 'M'];
  const LAYOUT_NAMES = { A: '晨光留白', B: '沉浸全幅', C: '經籤直書', I: '晨鐘大字', J: '象牙拱門', N: '上圖下文', P: '左右分割', Q: '三段式', K: '圓月', L: '卷軸', M: '裱框' };
  const SIZES = { portrait: [1080, 1350], og: [1200, 630] };          // 版面座標
  const PIXEL_SIZES = { portrait: [1620, 2025], og: [1200, 630] };    // 實際輸出的像素
  // 分享面板裡的小預覽（直式版面縮成 0.8 倍）：手機上一格只有約 260 CSS px 寬，
  // 用不到 1620 寬；真正傳出去、存下來的仍是 PIXEL_SIZES.portrait 全尺寸。
  const PREVIEW_PIXELS = [540, 675];
  const GREETINGS = ['早安', '午安', '晚安', '法安', '自在', '吉祥'];   // 法安／自在／吉祥 = 不分時間，給跨時區的收件人
  const SERIF = '"Noto Serif TC", "Noto Serif CJK TC", "Source Han Serif TC", "Songti TC", serif';

  const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const PUNCT = '，。；：、！？';
  const TRAIL_PUNCT_RE = /[，。；：、！？,.;:!?]+$/;

  // ── 日期 ────────────────────────────────────────────────────────────
  // 二十四節氣（21 世紀通式，與首頁 app.js 相同）
  const SOLAR_TERMS = [
    ['小寒', 1, 5.4055], ['大寒', 1, 20.12], ['立春', 2, 3.87], ['雨水', 2, 18.73],
    ['驚蟄', 3, 5.63], ['春分', 3, 20.646], ['清明', 4, 4.81], ['穀雨', 4, 20.1],
    ['立夏', 5, 5.52], ['小滿', 5, 21.04], ['芒種', 6, 5.678], ['夏至', 6, 21.37],
    ['小暑', 7, 7.108], ['大暑', 7, 22.83], ['立秋', 8, 7.5], ['處暑', 8, 23.13],
    ['白露', 9, 7.646], ['秋分', 9, 23.042], ['寒露', 10, 8.318], ['霜降', 10, 23.438],
    ['立冬', 11, 7.438], ['小雪', 11, 22.36], ['大雪', 12, 7.18], ['冬至', 12, 21.94]
  ];
  function solarTermDay(year, idx) {
    const y = ((year % 100) + 100) % 100;
    const [, month, c] = SOLAR_TERMS[idx];
    const leap = month <= 2 ? Math.floor((y - 1) / 4) : Math.floor(y / 4);
    return Math.floor(y * 0.2422 + c) - leap;
  }
  function solarTerm(year, m, d) {
    for (let i = SOLAR_TERMS.length - 1; i >= 0; i--) {
      const tm = SOLAR_TERMS[i][1];
      if (tm < m || (tm === m && solarTermDay(year, i) <= d)) return SOLAR_TERMS[i][0];
    }
    return '冬至';
  }
  function cnNumber(n) {
    if (n < 10) return CN_DIGITS[n];
    const tens = Math.floor(n / 10), ones = n % 10;
    return (tens === 1 ? '' : CN_DIGITS[tens]) + '十' + (ones ? CN_DIGITS[ones] : '');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 'YYYY-MM-DD' 合法就回傳原字串，否則 null。 */
  function normalizeDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2199 || mo < 1 || mo > 12 || d < 1) return null;
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  /** 由 'YYYY-MM-DD' 算出卡片上要寫的各種日期字樣（只看日期，不受時區影響）。 */
  function dateInfo(ymd) {
    const s = normalizeDate(ymd) || '2000-01-01';
    const [y, mo, d] = s.split('-').map(Number);
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    return {
      ymd: s,
      dotted: `${y} · ${pad2(mo)} · ${pad2(d)}`,
      day: pad2(d),
      monthCn: `${cnNumber(mo)}月`,
      cnFull: `${String(y).split('').map(c => CN_DIGITS[+c]).join('')}年${cnNumber(mo)}月${cnNumber(d)}日`,
      week: `星期${CN_WEEKDAYS[wd]}`,
      term: solarTerm(y, mo, d)
    };
  }

  /** 依小時給問候語（與首頁相同）。 */
  function greetingForHour(h) {
    if (h >= 5 && h < 11) return '早安';
    if (h >= 11 && h < 18) return '午安';
    return '晚安';
  }

  /** 某個時區此刻的日期（YYYY-MM-DD）與小時（0–23）；時區無效時用 UTC。 */
  function zonedNow(tz, date) {
    const d = date instanceof Date ? date : new Date();
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d);
    } catch (_) {
      return zonedNow('UTC', d);
    }
    const get = (t) => (parts.find(p => p.type === t) || {}).value;
    return { ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
  }

  function normalizeGreeting(g) { return GREETINGS.includes(g) ? g : '早安'; }
  const LABELS = ['每日經句', '經文選句'];
  function normalizeLabel(l) { return LABELS.includes(String(l || '')) ? String(l) : LABELS[0]; }
  function normalizeLayout(l) { return LAYOUTS.includes(String(l || '').toUpperCase()) ? String(l).toUpperCase() : 'A'; }
  function normalizeSize(s) { return s === 'og' ? 'og' : 'portrait'; }

  /** 印章字：站名裡的前兩個漢字，沒有就用「吉祥」。 */
  function sealText(siteName) {
    const han = Array.from(String(siteName || '')).filter(c => /\p{Script=Han}/u.test(c));
    return han.length >= 2 ? han.slice(0, 2).join('') : '吉祥';
  }

  // ── 經句斷行 ─────────────────────────────────────────────────────────
  /** 經句切成分句（標點留在分句尾）。 */
  function clauses(text) {
    const t = String(text || '').replace(/\s+/g, '').trim();
    return t.match(new RegExp(`[^${PUNCT}]+[${PUNCT}]*`, 'g')) || (t ? [t] : []);
  }

  /**
   * 把分句裝進每行最多 max 字的行裡：分句盡量不拆，太長才硬切；
   * 行尾的標點拿掉（卡片上用斷行代替逗號句號，比較像對聯）。
   */
  function packLines(text, max) {
    const out = [];
    let cur = '';
    for (const c of clauses(text)) {
      const chars = Array.from(c);
      const bare = Array.from(c.replace(TRAIL_PUNCT_RE, ''));
      if (cur && Array.from(cur).length + bare.length <= max) { cur += c; continue; }
      if (cur) out.push(cur);
      if (bare.length <= max) { cur = c; continue; }
      cur = '';
      for (let i = 0; i < chars.length; i += max) {
        const piece = chars.slice(i, i + max).join('');
        if (i + max >= chars.length) cur = piece; else out.push(piece);
      }
    }
    if (cur) out.push(cur);
    return out.map(l => l.replace(TRAIL_PUNCT_RE, '')).filter(Boolean);
  }

  /**
   * 找最大的字級，讓經句在 boxW × boxH 裡排得下。
   * 回傳 { size, lines }。advance = 每字佔的寬（含字距）÷ 字級；lead = 行距 ÷ 字級。
   */
  function fitText(text, { boxW, boxH, maxSize, minSize, advance, lead, maxLines = 99 }) {
    let best = null;
    for (let size = maxSize; size >= minSize; size -= 2) {
      const perLine = Math.max(1, Math.floor((boxW + size * (advance - 1)) / (size * advance)));
      let lines = packLines(text, perLine);
      // 行數不變的前提下把每行縮短，讓各行長度接近（不會最後一行只剩幾個字）
      for (let p = perLine - 1; p >= 1; p--) {
        const t = packLines(text, p);
        if (t.length !== lines.length) break;
        lines = t;
      }
      const h = size + (lines.length - 1) * size * lead;
      best = { size, lines };
      if (lines.length <= maxLines && h <= boxH) return best;
    }
    if (!best) return { size: minSize, lines: [String(text || '')] };
    // 縮到最小字級還放不下：只留排得下的行數，最後一行補「…」，不畫出界
    const room = Math.max(1, Math.min(maxLines, Math.floor((boxH - best.size) / (best.size * lead)) + 1));
    if (best.lines.length > room) {
      const kept = best.lines.slice(0, room);
      kept[room - 1] = `${kept[room - 1].replace(TRAIL_PUNCT_RE, '')}…`;
      best = { size: best.size, lines: kept };
    }
    return best;
  }

  // ── 繪圖小工具 ───────────────────────────────────────────────────────
  function font(weight, size) { return `${weight} ${Math.round(size)}px ${SERIF}`; }

  /** 一個字一個字畫，字距 spacing（px）。align: left / center / right。 */
  function drawSpaced(ctx, text, x, y, spacing, align = 'left') {
    const chars = Array.from(String(text));
    const widths = chars.map(c => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + spacing; });
    ctx.textAlign = prev;
    return total;
  }

  // 直書時換成直排用的標點字形
  const VERTICAL_FORMS = { '，': '︐', '。': '︒', '、': '︑', '：': '︓', '；': '︔', '！': '︕', '？': '︖', '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '（': '︵', '）': '︶', '—': '︱', '…': '︙', '·': '・' };

  /** 直書一欄：x 為欄中線，y 為第一字頂端；step = 每字佔的高。回傳畫完的高度。 */
  function drawVertical(ctx, text, x, y, size, step) {
    const prevA = ctx.textAlign, prevB = ctx.textBaseline;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const chars = Array.from(String(text));
    chars.forEach((c, i) => {
      const ch = VERTICAL_FORMS[c] || c;
      if (/[0-9A-Za-z]/.test(ch)) {
        ctx.save();
        ctx.translate(x, y + i * step + size / 2);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(ch, x, y + i * step + size / 2);
      }
    });
    ctx.textAlign = prevA;
    ctx.textBaseline = prevB;
    return chars.length ? (chars.length - 1) * step + size : 0;
  }

  /** 圖片以 cover 方式填滿 (x, y, w, h)；focusY 控制上下取哪一段（0 頂、0.5 中、1 底）。 */
  function drawCover(ctx, img, x, y, w, h, focusX = 0.5, focusY = 0.5) {
    if (!img || !img.width || !img.height) {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#9ec5e8');
      g.addColorStop(0.55, '#e8eef2');
      g.addColorStop(1, '#f3e3bf');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      return;
    }
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale, sh = h / scale;
    const sx = (img.width - sw) * focusX, sy = (img.height - sh) * focusY;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  /** 畫面某區域的平均亮度（0–1）。讀不到像素（例如跨網域圖）就當 0.6。 */
  function regionLuminance(ctx, x, y, w, h) {
    try {
      const step = 8;
      const data = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data;
      let sum = 0, n = 0;
      const rowLen = Math.round(w) * 4;
      for (let r = 0; r < Math.round(h); r += step) {
        for (let c = 0; c < rowLen; c += 4 * step) {
          const i = r * rowLen + c;
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          n++;
        }
      }
      return n ? sum / n : 0.6;
    } catch (_) { return 0.6; }
  }

  function drawSeal(ctx, text, x, y, s) {
    const chars = Array.from(text).slice(0, 2);
    ctx.save();
    ctx.fillStyle = 'rgba(255,250,240,0.7)';
    roundRect(ctx, x, y, s, s, s * 0.1);
    ctx.fill();
    ctx.strokeStyle = '#b8322a';
    ctx.lineWidth = Math.max(2, s * 0.05);
    roundRect(ctx, x, y, s, s, s * 0.1);
    ctx.stroke();
    ctx.fillStyle = '#b8322a';
    ctx.font = font(700, s * 0.36);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chars[0] || '', x + s / 2, y + s * 0.3);
    ctx.fillText(chars[1] || '', x + s / 2, y + s * 0.7);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function withGlow(ctx, color, blur, fn) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    fn();
    ctx.restore();
  }

  // ── 版型 A：晨光留白 ─────────────────────────────────────────────────

  function drawA(ctx, w, h, o) {
    const land = w > h;
    ctx.fillStyle = T.top;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    if (!land) {
      const ih = Math.round(h * 0.58);
      drawCover(ctx, o.image, 0, 0, w, ih, 0.5, 0.45);
      const fade = ctx.createLinearGradient(0, ih * 0.55, 0, ih);
      fade.addColorStop(0, `rgba(${T.rgb},0)`);
      fade.addColorStop(1, T.top);
      ctx.fillStyle = fade;
      ctx.fillRect(0, ih * 0.55 - 1, w, ih * 0.45 + 2);
      // 上方：問候＋日期（白色光暈讓字從天空中浮出來）
      withGlow(ctx, 'rgba(255,255,255,0.95)', 24, () => {
        ctx.fillStyle = '#2b2a33';
        ctx.font = font(700, 120);
        drawSpaced(ctx, o.greeting, 64, 168, 12);
        ctx.font = font(500, 30);
        drawSpaced(ctx, o.date.dotted, w - 64, 92, 3, 'right');
        drawSpaced(ctx, `${o.date.week} · ${o.date.term}`, w - 64, 138, 3, 'right');
      });
      // 經句
      ctx.fillStyle = T.gold;
      ctx.font = font(500, 26);
      drawSpaced(ctx, '◆ ◆ ◆', w / 2, ih + 30, 14, 'center');
      const fit = fitText(o.verse.text, { boxW: w - 180, boxH: h - ih - 290, maxSize: 66, minSize: 34, advance: 1.12, lead: 1.65, maxLines: 6 });
      ctx.fillStyle = T.ink;
      ctx.font = font(700, fit.size);
      let y = ih + 70 + fit.size;
      const blockH = fit.size + (fit.lines.length - 1) * fit.size * 1.65;
      const room = h - ih - 290;
      y += Math.max(0, (room - blockH) / 2);
      for (const line of fit.lines) { drawSpaced(ctx, line, w / 2, y, fit.size * 0.12, 'center'); y += fit.size * 1.65; }
      if (o.verse.source) {
        ctx.fillStyle = T.inkSoft;
        ctx.font = font(500, 30);
        drawSpaced(ctx, `——《${o.verse.source}》`, w / 2, y - fit.size * 1.65 + 72, 4, 'center');
      }
      // 頁尾
      ctx.fillStyle = T.rule;
      ctx.fillRect(64, h - 140, w - 128, 1.5);
      ctx.fillStyle = T.muted;
      ctx.font = font(500, 24);
      drawSpaced(ctx, `${o.siteName} · ${o.label}`, 64, h - 74, 3);
      if (o.qr) {
        // QR 與「吉祥」印同大，排在印的右邊
        drawSeal(ctx, '吉祥', w - 64 - QR_BOX - 20 - 64, h - 116, 64);
        drawQrBadge(ctx, o, w - 64 - QR_BOX, h - 116);
      } else {
        drawSeal(ctx, '吉祥', w - 64 - 64, h - 116, 64);
      }
      return;
    }
    // 橫式：左圖右文
    const iw = Math.round(w * 0.5);
    drawCover(ctx, o.image, 0, 0, iw, h, 0.5, 0.5);
    const fade = ctx.createLinearGradient(iw * 0.6, 0, iw, 0);
    fade.addColorStop(0, `rgba(${T.rgb},0)`);
    fade.addColorStop(1, T.top);
    ctx.fillStyle = fade;
    ctx.fillRect(iw * 0.6, 0, iw * 0.4 + 1, h);
    const x0 = iw + 40, x1 = w - 64;
    ctx.fillStyle = T.ink;
    ctx.font = font(700, 72);
    const gw = drawSpaced(ctx, o.greeting, x0, 126, 8);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 22);
    drawSpaced(ctx, `${o.date.dotted} ${o.date.week} · ${o.date.term}`, x0 + gw + 22, 124, 2);
    const fit = fitText(o.verse.text, { boxW: x1 - x0, boxH: 230, maxSize: 48, minSize: 26, advance: 1.11, lead: 1.6, maxLines: 5 });
    ctx.fillStyle = T.ink;
    ctx.font = font(700, fit.size);
    const blockH = fit.size + (fit.lines.length - 1) * fit.size * 1.6;
    let y = 190 + (250 - blockH) / 2 + fit.size;
    for (const line of fit.lines) { drawSpaced(ctx, line, x0, y, fit.size * 0.11); y += fit.size * 1.6; }
    if (o.verse.source) {
      ctx.fillStyle = T.inkSoft;
      ctx.font = font(500, 24);
      drawSpaced(ctx, `——《${o.verse.source}》`, x0, y - fit.size * 1.6 + 52, 3);
    }
    ctx.fillStyle = T.rule;
    ctx.fillRect(x0, h - 108, x1 - x0, 1.5);
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.siteName}${o.host ? ' · ' + o.host : ''}`, x0, h - 58, 2);
    drawSeal(ctx, '吉祥', x1 - 48, h - 92, 48);
  }

  // ── 版型 B：沉浸全幅 ─────────────────────────────────────────────────
  function drawB(ctx, w, h, o) {
    const land = w > h, k = land ? 0.62 : 1;
    drawCover(ctx, o.image, 0, 0, w, h, 0.5, 0.5);
    // 下半部越亮，漸層就越深，白字才讀得清楚
    const lum = regionLuminance(ctx, 0, h * 0.55, w, h * 0.45);
    const deep = Math.min(0.92, Math.max(0.7, 0.55 + lum * 0.4));
    const mid = Math.min(0.68, Math.max(0.45, 0.3 + lum * 0.4));
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(18,22,40,0.38)');
    g.addColorStop(land ? 0.3 : 0.22, 'rgba(18,22,40,0)');
    g.addColorStop(land ? 0.36 : 0.42, 'rgba(18,22,40,0)');
    g.addColorStop(land ? 0.62 : 0.66, `rgba(18,22,40,${mid.toFixed(2)})`);
    g.addColorStop(1, `rgba(14,16,30,${deep.toFixed(2)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#fff';
    withGlow(ctx, 'rgba(0,0,0,0.45)', 14, () => {
      const top = 56 * k, left = 64 * k;
      ctx.font = font(700, 130 * k);
      const dw = drawSpaced(ctx, o.date.day, left, top + 108 * k, 2);
      ctx.font = font(500, 28 * k);
      drawSpaced(ctx, o.date.monthCn, left + dw + 22 * k, top + 48 * k, 4);
      ctx.font = font(500, 26 * k);
      drawSpaced(ctx, `${o.date.week} · ${o.date.term}`, left + dw + 22 * k, top + 92 * k, 3);
      ctx.font = font(700, 80 * k);
      drawSpaced(ctx, o.greeting, w - left, top + 100 * k, 14 * k, 'right');
    });

    const left = 80 * k, right = w - 80 * k;
    const qb = o.qr && !land ? qrBadgeSize() : null;
    const fit = land
      ? fitText(o.verse.text.replace(/\s+/g, ''), { boxW: right - left, boxH: 140, maxSize: 52, minSize: 28, advance: 1.12, lead: 1.5, maxLines: 2 })
      : fitText(o.verse.text, { boxW: right - left, boxH: 420, maxSize: 70, minSize: 36, advance: 1.12, lead: 1.6, maxLines: 6 });
    const lead = land ? 1.5 : 1.6;
    // 由下往上排：頁尾 → 出處 → 經句 → 金線
    const footY = h - 70 * k;
    const srcY = footY - 74 * k;
    const lastY = srcY - 60 * k;
    const firstY = lastY - (fit.lines.length - 1) * fit.size * lead;
    ctx.fillStyle = '#e9c879';
    ctx.fillRect(left, firstY - fit.size - 36 * k, 80 * k, 3);
    withGlow(ctx, 'rgba(0,0,0,0.45)', 16, () => {
      ctx.fillStyle = '#fff';
      ctx.font = font(700, fit.size);
      fit.lines.forEach((line, i) => drawSpaced(ctx, line, left, firstY + i * fit.size * lead, fit.size * 0.12));
      if (o.verse.source) {
        ctx.fillStyle = '#f1dfb2';
        ctx.font = font(500, 30 * k);
        drawSpaced(ctx, `《${o.verse.source}》`, left, srcY, 4);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = font(500, 22 * k);
      drawSpaced(ctx, `${o.siteName} · ${o.label}`, left, footY, 3);
      if (o.host && !qb) drawSpaced(ctx, o.host, right, footY, 2, 'right');
    });
    if (qb) drawQrBadge(ctx, o, right - qb.w + 16, h - 26 - qb.h);
  }

  // ── 版型 C：經籤直書 ─────────────────────────────────────────────────
  function drawC(ctx, w, h, o) {
    const land = w > h;
    drawCover(ctx, o.image, 0, 0, w, h, 0.5, 0.5);
    const sw = land ? 420 : 520, sh = land ? 530 : 1060;
    const sx = land ? w - 70 - sw : (w - sw) / 2, sy = land ? 50 : 120;
    // 經籤
    ctx.save();
    ctx.shadowColor = 'rgba(40,30,10,0.28)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 24;
    ctx.fillStyle = `rgba(${T.tag},0.92)`;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();
    ctx.strokeStyle = `rgba(${T.tagLine},0.75)`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    ctx.strokeStyle = `rgba(${T.tagLine},0.4)`;
    ctx.strokeRect(sx + 14, sy + 14, sw - 28, sh - 28);

    const padT = land ? 44 : 72, padB = land ? 40 : 64;
    const colTop = sy + padT, colBottom = sy + sh - padB;
    let x = sx + sw - (land ? 62 : 86);
    // 問候（紅）
    const gs = land ? 64 : 96;
    ctx.fillStyle = T.red;
    ctx.font = font(700, gs);
    drawVertical(ctx, o.greeting, x, colTop, gs, gs * 1.12);
    x -= gs * 0.5 + (land ? 26 : 36);
    // 日期
    const ds = land ? 20 : 28;
    ctx.fillStyle = T.tagSoft;
    ctx.font = font(500, ds);
    drawVertical(ctx, `${o.date.cnFull}　${o.date.week}　${o.date.term}`, x, colTop, ds, ds * 1.18);
    x -= ds * 0.5 + (land ? 26 : 36);
    // 經句：每欄一行，從右到左
    const vsTop = colTop + (land ? 20 : 40);
    const srcSize = land ? 20 : 28;
    const leftLimit = sx + (land ? 40 : 56) + srcSize + 16;
    const avail = x + 1 - leftLimit;
    // 一個分句一欄最好看；欄數太多排不下才把欄拉長，再不行才縮字
    const longest = Math.max(1, ...clauses(o.verse.text).map(c => Array.from(c.replace(TRAIL_PUNCT_RE, '')).length));
    const maxSize = land ? 42 : 62;
    const fitsCols = (sz, perCol) => {
      const ls = packLines(o.verse.text, perCol);
      return ls.length * sz * 1.6 <= avail + sz * 0.5 ? ls : null;
    };
    let size = maxSize, lines = null;
    // 先試「一分句一欄」，字可以縮到七成；還排不下才讓一欄放多個分句
    for (let sz = maxSize; sz >= Math.round(maxSize * 0.7) && !lines; sz -= 2) {
      const capacity = Math.max(1, Math.floor((colBottom - vsTop) / (sz * 1.25)));
      if (longest <= capacity && (lines = fitsCols(sz, longest))) size = sz;
    }
    search:
    for (let sz = maxSize; sz >= 22 && !lines; sz -= 2) {
      const capacity = Math.max(1, Math.floor((colBottom - vsTop) / (sz * 1.25)));
      for (let perCol = Math.min(capacity, longest); perCol <= capacity; perCol++) {
        if ((lines = fitsCols(sz, perCol))) { size = sz; break search; }
      }
      size = sz;
    }
    if (!lines) lines = packLines(o.verse.text, Math.max(1, Math.floor((colBottom - vsTop) / (size * 1.25))));
    ctx.fillStyle = T.tagInk;
    ctx.font = font(700, size);
    x -= size / 2;
    for (const line of lines) { drawVertical(ctx, line, x, vsTop, size, size * 1.25); x -= size * 1.6; }
    // 出處：最左一欄，貼底
    if (o.verse.source) {
      const src = `《${o.verse.source}》`;
      const step = srcSize * 1.15;
      const sxCol = sx + (land ? 40 : 56) + srcSize / 2;
      const maxChars = Math.floor((colBottom - colTop - (land ? 60 : 90)) / step);
      const text = Array.from(src).slice(0, Math.max(3, maxChars)).join('');
      ctx.fillStyle = T.tagSoft;
      ctx.font = font(500, srcSize);
      drawVertical(ctx, text, sxCol, colBottom - (Array.from(text).length - 1) * step - srcSize, srcSize, step);
    }
    // 印章：蓋在問候那一欄的下端（那裡一定空著）
    const ss = land ? 44 : 60;
    drawSeal(ctx, sealText(o.siteName), sx + sw - (land ? 62 : 86) - ss / 2, colBottom - ss, ss);
    // 站名
    withGlow(ctx, 'rgba(255,255,255,0.95)', 14, () => {
      ctx.fillStyle = '#3a3226';
      ctx.font = font(500, land ? 22 : 28);
      const label = `${o.siteName} · ${o.label}${!land && o.host && !o.qr ? ' · ' + o.host : ''}`;
      if (land) drawSpaced(ctx, label, 60, h - 40, 6);
      else drawSpaced(ctx, label, w / 2, h - 44, 6, 'center');
    });
    if (o.qr && !land) { const b = qrBadgeSize(); drawQrBadge(ctx, o, 40, h - 40 - b.h); }
  }


  function goldLine(ctx, x, y, w, color = T.gold, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, 2);
    ctx.restore();
  }

  /** 把經句排進 (cx, cy) 為中心的框裡，置中。回傳 {size, lines, top, bottom}。 */
  function centerVerse(ctx, o, cx, cy, boxW, boxH, opts) {
    const fit = fitText(o.verse.text, Object.assign({ boxW, boxH, maxSize: 66, minSize: 30, advance: 1.12, lead: 1.65, maxLines: 6 }, opts || {}));
    const lead = (opts && opts.lead) || 1.65;
    const blockH = fit.size + (fit.lines.length - 1) * fit.size * lead;
    let y = cy - blockH / 2 + fit.size * 0.82;
    ctx.font = font(700, fit.size);
    for (const line of fit.lines) { drawSpaced(ctx, line, cx, y, fit.size * 0.12, 'center'); y += fit.size * lead; }
    return { size: fit.size, lines: fit.lines, top: cy - blockH / 2, bottom: cy + blockH / 2 };
  }

  // ════════════════════════════════════════════════════════════════════
  // 精品版面 I–M（直式 1080×1350 為主；橫式暫時沿用 A）
  // 共用的質感工具：紙紋、金箔漸層、金粉、蓮瓣
  // ════════════════════════════════════════════════════════════════════
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 紙紋：很淡的隨機細點，同一句同一天每次畫出來都一樣。 */
  function grain(ctx, w, h, seed, alpha, dark) {
    const r = rng(seed);
    ctx.save();
    for (let i = 0; i < 5200; i++) {
      const x = r() * w, y = r() * h, s = 0.6 + r() * 1.6;
      ctx.globalAlpha = alpha * (0.4 + r() * 0.6);
      ctx.fillStyle = (i % 3 === 0) ? (dark ? '#fff' : '#fff') : (dark ? '#000' : T.grain);
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  function goldGrad(ctx, x0, y0, x1, y1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#f3dc9c');
    g.addColorStop(0.35, '#d2a64c');
    g.addColorStop(0.6, '#f6e4ac');
    g.addColorStop(1, '#b98a35');
    return g;
  }

  /** 金粉：大小不一、半透明的光點。 */
  function dust(ctx, x, y, w, h, count, seed, color) {
    const r = rng(seed);
    ctx.save();
    for (let i = 0; i < count; i++) {
      const px = x + r() * w, py = y + r() * h, rad = 1.2 + Math.pow(r(), 3) * 7;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 2.4);
      g.addColorStop(0, color || 'rgba(255,236,170,0.95)');
      g.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.globalAlpha = 0.35 + r() * 0.65;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, rad * 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** 一片蓮瓣（尖頭），從圓心往外 r1→r2，寬 wid；畫在已 translate/rotate 的座標裡，朝 -y。 */
  function petalPath(ctx, r1, r2, wid) {
    ctx.beginPath();
    ctx.moveTo(0, -r1);
    ctx.bezierCurveTo(wid, -r1 - (r2 - r1) * 0.25, wid * 0.8, -r2 + (r2 - r1) * 0.28, 0, -r2);
    ctx.bezierCurveTo(-wid * 0.8, -r2 + (r2 - r1) * 0.28, -wid, -r1 - (r2 - r1) * 0.25, 0, -r1);
    ctx.closePath();
  }

  /** 蓮花分隔線：中間一片大瓣，兩側小瓣，左右拉出金線。 */
  function lotusDivider(ctx, cx, y, span, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(cx - span, y, span - 46, 1.6);
    ctx.fillRect(cx + 46, y, span - 46, 1.6);
    for (const [ang, sc] of [[-52, 0.62], [52, 0.62], [-26, 0.82], [26, 0.82], [0, 1]]) {
      ctx.save();
      ctx.translate(cx, y + 14);
      ctx.rotate(ang * Math.PI / 180);
      petalPath(ctx, 2, 40 * sc, 13 * sc);
      ctx.globalAlpha = 0.22; ctx.fill();
      ctx.globalAlpha = 0.95; ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ── 版型 I：晨鐘大字 ────────────────────────────────────────────────
  // 海報式不對稱：整幅圖往右漸隱成米色，右側兩欄超大直書經句，「早安」是一方紅印。
  function drawI(ctx, w, h, o) {
    if (w > h) return drawILand(ctx, w, h, o);
    const CREAM = T.rgb;
    ctx.fillStyle = `rgb(${CREAM})`;
    ctx.fillRect(0, 0, w, h);
    drawCover(ctx, o.image, 0, 0, w, h, 0.4, 0.5);
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, `rgba(${CREAM},0)`);
    gx.addColorStop(0.22, `rgba(${CREAM},0.05)`);
    gx.addColorStop(0.58, `rgba(${CREAM},0.93)`);
    gx.addColorStop(1, `rgba(${CREAM},0.98)`);
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, w, h);
    const gy = ctx.createLinearGradient(0, h * 0.72, 0, h);
    gy.addColorStop(0, `rgba(${CREAM},0)`);
    gy.addColorStop(1, `rgba(${CREAM},0.97)`);
    ctx.fillStyle = gy;
    ctx.fillRect(0, h * 0.72, w, h * 0.28);
    dust(ctx, 0, 0, w * 0.62, h * 0.7, 46, 11);
    grain(ctx, w, h, 5, 0.05, false);
    // 右側直書
    const top = 250, bottom = h - 250;
    const longest = Math.max(1, ...clauses(o.verse.text).map(c => Array.from(c.replace(TRAIL_PUNCT_RE, '')).length));
    let size = 132, lines = null;
    for (; size >= 56 && !lines; size -= 4) {
      const cap = Math.floor((bottom - top) / (size * 1.14));
      for (let pc = Math.min(longest, cap); pc <= cap && !lines; pc++) {
        const ls = packLines(o.verse.text, pc);
        if (ls.length <= 3 && ls.length * size * 1.5 <= 470) lines = ls;
      }
      if (lines) break;
    }
    if (!lines) { size = 56; lines = packLines(o.verse.text, Math.floor((bottom - top) / (size * 1.14))); }
    ctx.fillStyle = T.ink;
    ctx.font = font(900, size);
    let x = w - 96 - size / 2;
    for (const line of lines) { drawVertical(ctx, line, x, top, size, size * 1.14); x -= size * 1.5; }
    const colLen = Math.max(...lines.map(l => Array.from(l).length)) * size * 1.14;
    // 出處（直書、較小，貼在最左一欄的下方）
    if (o.verse.source) {
      ctx.fillStyle = T.source;
      ctx.font = font(500, 30);
      const txt = `《${o.verse.source}》`;
      const step = 34;
      drawVertical(ctx, txt, x + size * 0.5 - 6, Math.min(top + colLen + 40, bottom - (Array.from(txt).length - 1) * step), 30, step);
    }
    // 紅印「早安」
    const ss = 138;
    const sx = w - 96 - ss + 6, sy = 84;
    ctx.save();
    ctx.fillStyle = '#b8322a';
    roundRect(ctx, sx, sy, ss, ss, 10);
    ctx.fill();
    ctx.fillStyle = '#fbf3e4';
    ctx.font = font(900, 56);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const gch = Array.from(o.greeting);
    ctx.fillText(gch[0] || '', sx + ss * 0.5, sy + ss * 0.29);
    ctx.fillText(gch[1] || '', sx + ss * 0.5, sy + ss * 0.72);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    // 左下：日期
    ctx.fillStyle = T.ink;
    ctx.font = font(700, 46);
    drawSpaced(ctx, `${o.date.monthCn}${cnNumber(+o.date.day)}日`, 80, h - 150, 6);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 28);
    drawSpaced(ctx, `${o.date.week} · ${o.date.term}`, 80, h - 100, 5);
    goldLine(ctx, 80, h - 76, 120, T.gold);
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 22);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, 80, h - 40, 4);
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, w - 96 - b.w + 20, h - 44 - b.h); }
  }

  // ── 版型 J：象牙拱門 ────────────────────────────────────────────────
  // 象牙白的紙，一座尖頂拱門的畫窗、金色雙線與廊柱，蓮花分隔線，經句沉靜地寫在下方。
  function drawJ(ctx, w, h, o) {
    if (w > h) return drawJLand(ctx, w, h, o);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, T.top); bg.addColorStop(1, T.bottom);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    grain(ctx, w, h, 9, 0.06, false);
    // 廊柱：兩側細金線，端點小菱形
    ctx.strokeStyle = goldGrad(ctx, 0, 0, 0, h); ctx.lineWidth = 2;
    const qbJ = o.qr ? qrBadgeSize() : null;
    for (const x of [78, w - 78]) {
      const yEnd = qbJ ? h - 40 - qbJ.h - 36 : h - 130;
      ctx.beginPath(); ctx.moveTo(x, 130); ctx.lineTo(x, yEnd); ctx.stroke();
      for (const y of [130, yEnd]) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = goldGrad(ctx, -8, -8, 8, 8); ctx.fillRect(-7, -7, 14, 14); ctx.restore();
      }
    }
    // 問候
    ctx.fillStyle = T.red;
    ctx.font = font(900, 66);
    drawSpaced(ctx, o.greeting, w / 2, 148, 30, 'center');
    ctx.fillStyle = goldGrad(ctx, 0, 0, w, 0);
    ctx.fillRect(w / 2 - 250, 118, 130, 2); ctx.fillRect(w / 2 + 120, 118, 130, 2);
    // 拱形畫窗
    const ax = 170, aw = w - 340, ay = 200, ah = 660, ar = aw / 2;
    const arch = (inset) => {
      ctx.beginPath();
      ctx.moveTo(ax - inset, ay + ah + inset);
      ctx.lineTo(ax - inset, ay + ar);
      ctx.arc(ax + ar, ay + ar, ar + inset, Math.PI, 0);
      ctx.lineTo(ax + aw + inset, ay + ah + inset);
      ctx.closePath();
    };
    ctx.save(); arch(0); ctx.clip();
    drawCover(ctx, o.image, ax, ay, aw, ah, 0.5, 0.5);
    const sh = ctx.createLinearGradient(0, ay + ah * 0.6, 0, ay + ah);
    sh.addColorStop(0, 'rgba(60,40,10,0)'); sh.addColorStop(1, 'rgba(60,40,10,0.28)');
    ctx.fillStyle = sh; ctx.fillRect(ax, ay, aw, ah);
    ctx.restore();
    ctx.strokeStyle = goldGrad(ctx, ax, ay, ax + aw, ay + ah); ctx.lineWidth = 5; arch(0); ctx.stroke();
    ctx.lineWidth = 1.6; arch(16); ctx.stroke();
    ctx.lineWidth = 1; ctx.globalAlpha = 0.55; arch(30); ctx.stroke(); ctx.globalAlpha = 1;
    // 拱頂小寶珠
    ctx.fillStyle = goldGrad(ctx, 0, ay - 40, 0, ay);
    ctx.beginPath(); ctx.arc(w / 2, ay - 22, 9, 0, Math.PI * 2); ctx.fill();
    // 蓮花分隔線與經句
    lotusDivider(ctx, w / 2, 930, 300, T.gold);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, 1065, w - 260, 190, { maxSize: 56, minSize: 30, lead: 1.6, maxLines: 4 });
    if (o.verse.source) {
      ctx.fillStyle = T.source;
      ctx.font = font(500, 26);
      drawSpaced(ctx, `——《${o.verse.source}》`, w / 2, r.bottom + 46, 4, 'center');
    }
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 24);
    drawSpaced(ctx, `${o.date.cnFull}　${o.date.week} · ${o.date.term}`, w / 2, h - 100, 4, 'center');
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, w / 2, h - 64, 5, 'center');
    if (qbJ) drawQrBadge(ctx, o, w - 78 - qbJ.w / 2 - 6, h - 40 - qbJ.h);
  }

  // ════════════════════════════════════════════════════════════════════
  // 圖文並重版面 N–R（直式；圖片完整露出、不蓋半透明，文字有自己的底色區）
  // ════════════════════════════════════════════════════════════════════
  // 英文問候用手寫體（Dancing Script；伺服器由 Docker 建置時下載，沒有就退回宋體）
  const enFont = (sz) => `${Math.round(sz)}px "Dancing Script", ${SERIF}`;
  const GREETING_EN = { '早安': 'Good Morning', '午安': 'Good Afternoon', '晚安': 'Good Evening', '法安': 'Dharma Peace', '自在': 'Boundless Ease', '吉祥': 'Blessings' };

  function redSeal(ctx, text, x, y, s, r) {
    ctx.save();
    ctx.fillStyle = '#b8322a';
    roundRect(ctx, x, y, s, s, r == null ? s * 0.08 : r);
    ctx.fill();
    ctx.fillStyle = '#fbf3e4';
    ctx.font = font(900, s * 0.4);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const g = Array.from(text);
    ctx.fillText(g[0] || '', x + s * 0.5, y + s * 0.29);
    ctx.fillText(g[1] || '', x + s * 0.5, y + s * 0.72);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  function paperBg(ctx, x, y, w, h, c0, c1) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }

  function sourceLine(ctx, o, cx, y, color, size) {
    if (!o.verse.source) return;
    ctx.fillStyle = color;
    ctx.font = font(500, size || 28);
    drawSpaced(ctx, `——《${o.verse.source}》`, cx, y, 4, 'center');
  }

  // ── 版型 N：上圖下文 ────────────────────────────────────────────────
  // 上半整幅是圖，下半是宣紙色的字區；紅印「早安」跨在兩區交界。
  function drawN(ctx, w, h, o) {
    if (w > h) return drawNLand(ctx, w, h, o);
    const split = 820;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    drawCover(ctx, o.image, 0, 0, w, split, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, w, 0);
    ctx.fillRect(0, split, w, 6);
    grain(ctx, w, h - split, 3, 0.05, false);
    redSeal(ctx, o.greeting, w / 2 - 62, split - 62, 124);
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, w - 64 - b.w, split - b.h / 2); }
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, 1085, w - 200, 230, { maxSize: 62, minSize: 32, lead: 1.6, maxLines: 4 });
    sourceLine(ctx, o, w / 2, r.bottom + 50, T.source, 28);
    goldLine(ctx, 64, h - 96, w - 128, T.gold, 0.7);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 24);
    drawSpaced(ctx, `${o.date.cnFull}`, 64, h - 54, 4);
    drawSpaced(ctx, `${o.date.week} · ${o.date.term}`, w - 64, h - 54, 4, 'right');
  }

  // ── 版型 P：左右分割 ────────────────────────────────────────────────
  // 左邊整條直立的圖，右邊宣紙色字區放直書經句與紅印。
  function drawP(ctx, w, h, o) {
    if (w > h) return drawPLand(ctx, w, h, o);
    const pw = 440;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 6, 0.05, false);
    drawCover(ctx, o.image, 0, 0, pw, h, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, 0, h);
    ctx.fillRect(pw, 0, 6, h);
    const left = pw + 6, areaW = w - left;
    const top = 330, bottom = h - 170, colH = bottom - top;
    const longest = Math.max(1, ...clauses(o.verse.text).map(c => Array.from(c.replace(TRAIL_PUNCT_RE, '')).length));
    let size = 104, lines = null;
    for (; size >= 52 && !lines; size -= 4) {
      const cap = Math.floor(colH / (size * 1.14));
      for (let pc = Math.min(longest, cap); pc <= cap && !lines; pc++) {
        const ls = packLines(o.verse.text, pc);
        if (ls.length <= 3 && ls.length * size * 1.5 <= areaW - 110) lines = ls;
      }
      if (lines) break;
    }
    if (!lines) { size = 52; lines = packLines(o.verse.text, Math.floor(colH / (size * 1.14))); }
    ctx.fillStyle = T.ink;
    ctx.font = font(900, size);
    const blockW = lines.length * size * 1.5 - size * 0.5;
    let x = left + areaW / 2 + blockW / 2 - size / 2;
    for (const line of lines) { drawVertical(ctx, line, x, top, size, size * 1.14); x -= size * 1.5; }
    redSeal(ctx, o.greeting, left + areaW / 2 - 62, 110, 124);
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, 40, h - 40 - b.h); }
    if (o.verse.source) {
      ctx.fillStyle = T.source;
      ctx.font = font(500, 26);
      drawSpaced(ctx, `《${o.verse.source}》`, left + areaW / 2, h - 118, 3, 'center');
    }
    goldLine(ctx, left + 60, h - 90, areaW - 120, T.gold, 0.7);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 22);
    drawSpaced(ctx, `${o.date.monthCn}${cnNumber(+o.date.day)}日　${o.date.week} · ${o.date.term}`, left + areaW / 2, h - 50, 3, 'center');
  }

  // ── 版型 Q：三段式 ──────────────────────────────────────────────────
  // 上段超大「早安」，中段整幅的圖，下段經句；段與段之間用粗金線隔開。
  function drawQ(ctx, w, h, o) {
    if (w > h) return drawQLand(ctx, w, h, o);
    const t1 = 290, t2 = 1000;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 8, 0.05, false);
    ctx.fillStyle = T.ink;
    ctx.font = enFont(124);
    ctx.textAlign = 'left';
    ctx.fillText(GREETING_EN[o.greeting] || 'Good Morning', 64, 172);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 26);
    drawSpaced(ctx, `${o.date.dotted}　${o.date.week} · ${o.date.term}`, 64, 244, 5);
    ctx.fillStyle = '#b8322a';
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, w - 64 - b.w, 290 - 4 - 22 - b.h); }
    else ctx.fillRect(w - 64 - 90, 240, 90, 8);
    drawCover(ctx, o.image, 0, t1, w, t2 - t1, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, w, 0);
    ctx.fillRect(0, t1 - 4, w, 8);
    ctx.fillRect(0, t2 - 4, w, 8);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, 1135, w - 180, 190, { maxSize: 56, minSize: 30, lead: 1.6, maxLines: 3 });
    sourceLine(ctx, o, w / 2, r.bottom + 46, T.source, 26);
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, w / 2, h - 36, 5, 'center');
  }

  // 版型 N 的橫式：左圖右文。
  function drawNLand(ctx, w, h, o) {
    const split = 720;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    drawCover(ctx, o.image, 0, 0, split, h, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, 0, h);
    ctx.fillRect(split, 0, 6, h);
    grain(ctx, w, h, 3, 0.05, false);
    const cx = split + 6 + (w - split - 6) / 2;
    redSeal(ctx, o.greeting, cx - 44, 46, 88);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, cx, 330, w - split - 90, 240, { maxSize: 40, minSize: 24, lead: 1.6, maxLines: 6 });
    sourceLine(ctx, o, cx, r.bottom + 38, T.source, 21);
    goldLine(ctx, split + 46, h - 82, w - split - 92, T.gold, 0.7);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 19);
    drawSpaced(ctx, `${o.date.monthCn}${cnNumber(+o.date.day)}日　${o.date.week} · ${o.date.term}`, cx, h - 44, 3, 'center');
  }

  // 版型 P 的橫式：左邊直立的圖、右邊置中直書經句。
  function drawPLand(ctx, w, h, o) {
    const pw = 360;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 6, 0.05, false);
    drawCover(ctx, o.image, 0, 0, pw, h, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, 0, h);
    ctx.fillRect(pw, 0, 6, h);
    const left = pw + 6, areaW = w - left, cx = left + areaW / 2;
    const top = 134, bottom = h - 78, colH = bottom - top;
    let size = 64, lines = null;
    for (; size >= 26 && !lines; size -= 2) {
      const cap = Math.floor(colH / (size * 1.14));
      for (let pc = 4; pc <= cap && !lines; pc++) {
        const ls = packLines(o.verse.text, pc);
        if (ls.length <= 5 && ls.length * size * 1.5 <= areaW - 160) lines = ls;
      }
    }
    if (!lines) { size = 26; lines = packLines(o.verse.text, Math.floor(colH / (size * 1.14))); }
    ctx.fillStyle = T.ink;
    ctx.font = font(900, size);
    const blockW = lines.length * size * 1.5 - size * 0.5;
    let x = cx + blockW / 2 - size / 2;
    for (const line of lines) { drawVertical(ctx, line, x, top, size, size * 1.14); x -= size * 1.5; }
    redSeal(ctx, o.greeting, cx - 36, 34, 72);
    ctx.fillStyle = T.source;
    ctx.font = font(500, 19);
    if (o.verse.source) drawSpaced(ctx, `《${o.verse.source}》`, cx, h - 46, 3, 'center');
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 17);
    drawSpaced(ctx, `${o.date.monthCn}${cnNumber(+o.date.day)}日　${o.date.week} · ${o.date.term}`, cx, h - 20, 3, 'center');
  }

  // 版型 Q 的橫式：上條英文問候與日期、中間整幅的圖、下方經句。
  function drawQLand(ctx, w, h, o) {
    const t1 = 100, t2 = 440;
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 8, 0.05, false);
    ctx.fillStyle = T.ink;
    ctx.font = enFont(62);
    ctx.textAlign = 'left';
    ctx.fillText(GREETING_EN[o.greeting] || 'Good Morning', 44, 70);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.date.dotted}　${o.date.week} · ${o.date.term}`, w - 44, 66, 4, 'right');
    drawCover(ctx, o.image, 0, t1, w, t2 - t1, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, w, 0);
    ctx.fillRect(0, t1 - 3, w, 6);
    ctx.fillRect(0, t2 - 3, w, 6);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, 518, w - 160, 90, { maxSize: 36, minSize: 22, lead: 1.5, maxLines: 2 });
    sourceLine(ctx, o, w / 2, Math.min(r.bottom + 30, h - 14), T.source, 18);
  }

  // 版型 I 的橫式（連結預覽圖 1200×630）：圖在左、漸隱成米色，右側直書。
  function drawILand(ctx, w, h, o) {
    const CREAM = T.rgb;
    ctx.fillStyle = `rgb(${CREAM})`;
    ctx.fillRect(0, 0, w, h);
    drawCover(ctx, o.image, 0, 0, w, h, 0.4, 0.5);
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, `rgba(${CREAM},0)`);
    gx.addColorStop(0.3, `rgba(${CREAM},0.06)`);
    gx.addColorStop(0.58, `rgba(${CREAM},0.94)`);
    gx.addColorStop(1, `rgba(${CREAM},0.98)`);
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, w, h);
    dust(ctx, 0, 0, w * 0.6, h, 26, 11);
    grain(ctx, w, h, 5, 0.05, false);
    const top = 150, bottom = h - 56, colH = bottom - top;
    let size = 56, lines = null;
    for (; size >= 28 && !lines; size -= 2) {
      const cap = Math.floor(colH / (size * 1.14));
      for (let pc = 4; pc <= cap && !lines; pc++) {
        const ls = packLines(o.verse.text, pc);
        if (ls.length <= 4 && ls.length * size * 1.5 <= 520) lines = ls;
      }
    }
    if (!lines) { size = 28; lines = packLines(o.verse.text, Math.floor(colH / (size * 1.14))); }
    ctx.fillStyle = T.ink;
    ctx.font = font(900, size);
    let x = w - 70 - size / 2;
    for (const line of lines) { drawVertical(ctx, line, x, top, size, size * 1.14); x -= size * 1.5; }
    // 紅印
    const ss = 78, sx = w - 70 - ss + 4, sy = 40;
    ctx.save();
    ctx.fillStyle = '#b8322a';
    roundRect(ctx, sx, sy, ss, ss, 7);
    ctx.fill();
    ctx.fillStyle = '#fbf3e4';
    ctx.font = font(900, 32);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const gch = Array.from(o.greeting);
    ctx.fillText(gch[0] || '', sx + ss * 0.5, sy + ss * 0.29);
    ctx.fillText(gch[1] || '', sx + ss * 0.5, sy + ss * 0.72);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    // 日期放在紅印左邊（左下角壓在圖上不好讀）
    ctx.fillStyle = T.ink;
    ctx.font = font(700, 32);
    drawSpaced(ctx, `${o.date.monthCn}${cnNumber(+o.date.day)}日`, sx - 22, 74, 5, 'right');
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.date.week} · ${o.date.term}`, sx - 22, 106, 4, 'right');
  }

  // 版型 J 的橫式：左邊拱形畫窗，右邊問候、蓮花線、經句。
  function drawJLand(ctx, w, h, o) {
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, T.top); bg.addColorStop(1, T.bottom);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    grain(ctx, w, h, 9, 0.06, false);
    const ax = 86, aw = 380, ay = 74, ah = 482, ar = aw / 2;
    const arch = (inset) => {
      ctx.beginPath();
      ctx.moveTo(ax - inset, ay + ah + inset);
      ctx.lineTo(ax - inset, ay + ar);
      ctx.arc(ax + ar, ay + ar, ar + inset, Math.PI, 0);
      ctx.lineTo(ax + aw + inset, ay + ah + inset);
      ctx.closePath();
    };
    ctx.save(); arch(0); ctx.clip();
    drawCover(ctx, o.image, ax, ay, aw, ah, 0.5, 0.5);
    ctx.restore();
    ctx.strokeStyle = goldGrad(ctx, ax, ay, ax + aw, ay + ah); ctx.lineWidth = 4; arch(0); ctx.stroke();
    ctx.lineWidth = 1.4; arch(12); ctx.stroke();
    ctx.lineWidth = 1; ctx.globalAlpha = 0.55; arch(23); ctx.stroke(); ctx.globalAlpha = 1;
    const cx = ax + aw + (w - ax - aw) / 2 + 6;
    ctx.fillStyle = T.red;
    ctx.font = font(900, 50);
    drawSpaced(ctx, o.greeting, cx, 128, 24, 'center');
    lotusDivider(ctx, cx, 168, 240, T.gold);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, cx, 318, w - ax - aw - 170, 210, { maxSize: 42, minSize: 24, lead: 1.6, maxLines: 5 });
    if (o.verse.source) {
      ctx.fillStyle = T.source;
      ctx.font = font(500, 22);
      drawSpaced(ctx, `——《${o.verse.source}》`, cx, r.bottom + 40, 3, 'center');
    }
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.date.cnFull}　${o.date.week} · ${o.date.term}`, cx, h - 70, 3, 'center');
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 17);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, cx, h - 42, 4, 'center');
  }


  // ════════════════════════════════════════════════════════════════════
  // 底色專屬版型 K（月白）、L（竹青）、M（素紙）。直式為主；橫式（連結預覽）沿用 A。
  // ════════════════════════════════════════════════════════════════════
  /** 共用的下半部：經句置中、出處、日期、站名、QR。 */
  function tailBlock(ctx, w, h, o, cy, boxH, maxSize) {
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, cy, w - 260, boxH, { maxSize: maxSize || 56, minSize: 30, lead: 1.6, maxLines: 4 });
    sourceLine(ctx, o, w / 2, r.bottom + 46, T.source, 26);
    ctx.fillStyle = T.inkSoft;
    ctx.font = font(500, 24);
    drawSpaced(ctx, `${o.date.cnFull}　${o.date.week} · ${o.date.term}`, w / 2, h - 100, 4, 'center');
    ctx.fillStyle = T.muted;
    ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, w / 2, h - 64, 5, 'center');
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, w - 64 - b.w, h - 40 - b.h); }
    return r;
  }

  // ── 版型 K：圓月（月白底）──────────────────────────────────────────
  // 一輪圓月般的圓形畫窗，雙金環；上方紅字問候，下方蓮花線與經句。
  function drawK(ctx, w, h, o) {
    if (w > h) return drawA(ctx, w, h, o);
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 12, 0.05, false);
    ctx.fillStyle = T.red;
    ctx.font = font(900, 58);
    drawSpaced(ctx, o.greeting, w / 2, 128, 28, 'center');
    const cx = w / 2, cy = 540, R = 330;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    drawCover(ctx, o.image, cx - R, cy - R, R * 2, R * 2, 0.5, 0.5);
    ctx.restore();
    ctx.strokeStyle = goldGrad(ctx, cx - R, cy - R, cx + R, cy + R);
    ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, R + 20, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R + 36, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    lotusDivider(ctx, cx, 940, 280, T.gold);
    tailBlock(ctx, w, h, o, 1085, 190, 56);
  }

  // ── 版型 L：卷軸（竹青底）──────────────────────────────────────────
  // 整張圖滿版鋪開、不加任何遮罩或形狀，像一幅剛攤開的畫卷：圖的下緣是一根畫軸（兩端金頭），
  // 軸兩側垂下紅穗；問候在圖上方的紙邊，經句寫在畫軸下面的紙上。
  /** 穗子：從 (x, y) 垂下的紅繩、盤長結、玉珠與流蘇，總長 len。 */
  function drawTassel(ctx, x, y, len, s) {
    const k = s || 1;
    ctx.save();
    ctx.strokeStyle = '#a8322a'; ctx.lineWidth = 2.4 * k; ctx.lineCap = 'round';
    const knotY = y + len * 0.3, beadY = y + len * 0.52, tasselY = beadY + 14 * k;
    ctx.beginPath(); ctx.moveTo(x, y + 14 * k); ctx.bezierCurveTo(x + 10 * k, y + len * 0.12, x - 6 * k, y + len * 0.2, x, knotY - 9 * k); ctx.stroke();
    // 盤長結（小菱形回紋）
    ctx.save(); ctx.translate(x, knotY); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#b8322a'; ctx.fillRect(-8 * k, -8 * k, 16 * k, 16 * k);
    ctx.strokeStyle = 'rgba(255,220,190,0.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(-4.5 * k, -4.5 * k, 9 * k, 9 * k);
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(x, knotY + 9 * k); ctx.lineTo(x, beadY - 10 * k); ctx.stroke();
    // 玉珠
    const jade = ctx.createRadialGradient(x - 3 * k, beadY - 3 * k, 1, x, beadY, 10 * k);
    jade.addColorStop(0, '#e9f4ea'); jade.addColorStop(0.6, '#8fbf9f'); jade.addColorStop(1, '#4f8a68');
    ctx.fillStyle = jade; ctx.beginPath(); ctx.arc(x, beadY, 10 * k, 0, Math.PI * 2); ctx.fill();
    // 流蘇
    ctx.fillStyle = '#c9a24a'; ctx.fillRect(x - 6 * k, tasselY - 4 * k, 12 * k, 5 * k);
    ctx.lineWidth = 1.1 * k;
    for (let i = -5; i <= 5; i++) {
      ctx.strokeStyle = i % 2 ? '#b8322a' : '#9c2a24';
      ctx.beginPath(); ctx.moveTo(x + i * 1.2 * k, tasselY + 1 * k);
      ctx.quadraticCurveTo(x + i * 1.8 * k, tasselY + (len - (tasselY - y)) * 0.5, x + i * 2.4 * k + 2 * k, y + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  function scrollRod(ctx, x, y, w, thick) {
    const g = ctx.createLinearGradient(0, y, 0, y + thick);
    g.addColorStop(0, '#d9b676'); g.addColorStop(0.35, '#9a6a3c'); g.addColorStop(0.7, '#6e4524'); g.addColorStop(1, '#4a2d16');
    ctx.save();
    ctx.shadowColor = 'rgba(80,40,20,0.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 8;
    ctx.fillStyle = g; ctx.fillRect(x, y, w, thick);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,236,200,0.35)'; ctx.fillRect(x, y + 2, w, 2);
    for (const cx of [x + 10, x + w - 10]) {
      const k = ctx.createRadialGradient(cx - 3, y + thick / 2 - 3, 1, cx, y + thick / 2, thick * 0.8);
      k.addColorStop(0, '#fff2c8'); k.addColorStop(0.55, '#d2a64c'); k.addColorStop(1, '#8a6224');
      ctx.fillStyle = k; ctx.beginPath(); ctx.arc(cx, y + thick / 2, thick * 0.72, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawL(ctx, w, h, o) {
    if (w > h) return drawLLand(ctx, w, h, o);
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 13, 0.05, false);
    ctx.fillStyle = T.red; ctx.font = font(900, 56);
    drawSpaced(ctx, o.greeting, 64, 104, 24);
    ctx.fillStyle = T.inkSoft; ctx.font = font(500, 24);
    drawSpaced(ctx, `${o.date.dotted}　${o.date.week} · ${o.date.term}`, w - 64, 98, 4, 'right');
    const iy = 140, ih = 800;
    drawCover(ctx, o.image, 0, iy, w, ih, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, w, 0);
    ctx.fillRect(0, iy - 2, w, 3);
    scrollRod(ctx, 0, iy + ih, w, 26);
    drawTassel(ctx, 130, iy + ih + 22, 130, 1.0);
    drawTassel(ctx, w - 130, iy + ih + 22, 130, 1.0);
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, w / 2, 1108, w - 360, 140, { maxSize: 50, minSize: 28, lead: 1.6, maxLines: 3 });
    sourceLine(ctx, o, w / 2, r.bottom + 40, T.source, 24);
    ctx.fillStyle = T.muted; ctx.font = font(500, 20);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, w / 2, h - 40, 5, 'center');
    if (o.qr) { const b = qrBadgeSize(); drawQrBadge(ctx, o, w - 64 - b.w, h - 40 - b.h); }
    else drawSeal(ctx, '吉祥', w - 64 - 56, h - 40 - 56, 56);
  }

  // 版型 L 的橫式（連結預覽）：圖在左半、滿版高、不遮罩，右邊是紙。
  function drawLLand(ctx, w, h, o) {
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 13, 0.05, false);
    const iw = 700;
    drawCover(ctx, o.image, 0, 0, iw, h, 0.5, 0.5);
    ctx.fillStyle = goldGrad(ctx, 0, 0, 0, h); ctx.fillRect(iw, 0, 4, h);
    const cx = iw + 4 + (w - iw - 4) / 2;
    ctx.fillStyle = T.red; ctx.font = font(900, 50);
    drawSpaced(ctx, o.greeting, cx, 120, 26, 'center');
    ctx.fillStyle = T.ink;
    const r = centerVerse(ctx, o, cx, 300, w - iw - 100, 220, { maxSize: 40, minSize: 24, lead: 1.6, maxLines: 5 });
    sourceLine(ctx, o, cx, r.bottom + 38, T.source, 21);
    ctx.fillStyle = T.inkSoft; ctx.font = font(500, 19);
    drawSpaced(ctx, `${o.date.cnFull}　${o.date.week} · ${o.date.term}`, cx, h - 64, 3, 'center');
    ctx.fillStyle = T.muted; ctx.font = font(500, 17);
    drawSpaced(ctx, `${o.siteName} · ${o.label}`, cx, h - 36, 4, 'center');
  }

  // ── 版型 M：裱框（素紙底）──────────────────────────────────────────
  // 像掛在牆上的一幅裱好的畫：細外框、留白襯紙、圖外再描一圈細線；字全部置中，極簡。
  function drawM(ctx, w, h, o) {
    if (w > h) return drawA(ctx, w, h, o);
    paperBg(ctx, 0, 0, w, h, T.top, T.bottom);
    grain(ctx, w, h, 14, 0.04, false);
    ctx.strokeStyle = T.rule; ctx.lineWidth = 1.5;
    ctx.strokeRect(40.5, 40.5, w - 81, h - 81);
    ctx.fillStyle = T.ink;
    ctx.font = font(700, 44);
    drawSpaced(ctx, o.greeting, w / 2, 128, 22, 'center');
    const ix = 150, iy = 190, iw = w - 300, ih = 700;
    ctx.save();
    ctx.shadowColor = 'rgba(30,30,20,0.22)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 10;
    ctx.fillStyle = T.top; ctx.fillRect(ix, iy, iw, ih);
    ctx.restore();
    drawCover(ctx, o.image, ix, iy, iw, ih, 0.5, 0.5);
    ctx.strokeStyle = T.gold; ctx.lineWidth = 1.4;
    ctx.strokeRect(ix - 16.5, iy - 16.5, iw + 33, ih + 33);
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.strokeRect(ix - 30.5, iy - 30.5, iw + 61, ih + 61);
    ctx.globalAlpha = 1;
    goldLine(ctx, w / 2 - 60, 960, 120, T.gold);
    tailBlock(ctx, w, h, o, 1085, 190, 54);
  }

  // ── QR 碼小籤（原文連結）────────────────────────────────────────────
  // o.qr = { modules: boolean[][] }。一律畫在不透明的米色籤上（深色格子＋淺色底），
  // 背景圖亮或暗都掃得到；不寫字。籤與「吉祥」印同大（版面座標 64），
  // 格子用實際畫布像素的整數大小畫（1620 寬時 25×25 格每格 3 px），邊緣才銳利。
  const QR_BOX = 64;
  const QR_ALNUM_RE = /^[0-9A-Z $%*+\-.\/:]+$/;

  /** 網址 → QR 格子（容錯 M）。全大寫網址用英數模式，格數較少。沒有產生器或失敗回 null。 */
  function qrMatrix(text) {
    const lib = getQrLib();
    const s = String(text || '');
    if (!lib || !s) return null;
    try {
      const q = lib(0, 'M');
      q.addData(s, QR_ALNUM_RE.test(s) ? 'Alphanumeric' : 'Byte');
      q.make();
      const n = q.getModuleCount();
      const modules = [];
      for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
        modules.push(row);
      }
      return { modules };
    } catch (_) {
      return null;
    }
  }
  function qrBadgeSize() { return { w: QR_BOX, h: QR_BOX }; }
  function drawQrBadge(ctx, o, x, y) {
    const m = o.qr.modules, n = m.length;
    const t = ctx.getTransform ? ctx.getTransform() : { a: 1, e: 0, f: 0 };
    const s = t.a || 1;
    const X = Math.round(x * s + t.e), Y = Math.round(y * s + t.f), W = Math.round(QR_BOX * s);
    const mod = Math.max(1, Math.floor(W / (n + 4)));
    const pad = Math.floor((W - n * mod) / 2);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = 'rgba(40,30,10,0.18)';
    ctx.shadowBlur = 6 * s;
    ctx.shadowOffsetY = 1.5 * s;
    ctx.fillStyle = '#fbf7ec';
    roundRect(ctx, X, Y, W, W, 6 * s);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(176,141,74,0.8)';
    ctx.lineWidth = Math.max(1, s);
    roundRect(ctx, X + 0.5, Y + 0.5, W - 1, W - 1, 6 * s);
    ctx.stroke();
    ctx.fillStyle = '#211c16';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (m[r][c]) ctx.fillRect(X + pad + c * mod, Y + pad + r * mod, mod, mod);
    }
    ctx.restore();
    return { x, y, w: QR_BOX, h: QR_BOX };
  }

  /**
   * 畫一張卡。ctx 是 2D context（瀏覽器或 @napi-rs/canvas 都可以），畫布大小要先設好。
   * opts: { layout, base, size, image, verse: { text, source }, greeting, date: 'YYYY-MM-DD', siteName, host, label, qr }
   * base = 底色（BASE_IDS：cream 奶油〔預設〕、moon 月白、bamboo 竹青、plain 素紙），只影響紙底版型；B 只給奶油，K/L/M 各是月白/竹青/素紙專屬。
   * qr = 原文連結網址（短網址），只畫在直式；不給就不畫。畫布請用 PIXEL_SIZES 的大小。
   * label = 頁尾站名後的字：每日經句（預設）或 經文選句（選字製作的卡片）。
   */
  function draw(ctx, opts) {
    const size = normalizeSize(opts.size);
    const [w, h] = SIZES[size];
    const o = {
      image: opts.image || null,
      verse: { text: String((opts.verse && opts.verse.text) || ''), source: String((opts.verse && opts.verse.source) || '').replace(/^《|》$/g, '') },
      greeting: normalizeGreeting(opts.greeting),
      date: dateInfo(opts.date),
      siteName: String(opts.siteName || 'mdWebview'),
      host: String(opts.host || ''),
      label: normalizeLabel(opts.label),
      // QR 只畫在直式（og 是連結預覽，本身就能點，縮圖後也掃不到）
      qr: size === 'portrait' && opts.qr ? qrMatrix(opts.qr) : null
    };
    const layout = layoutFor(opts.layout, opts.base);
    // 畫布比版面大（直式 1620 寬）時整體放大
    const sc = ctx.canvas && ctx.canvas.width ? ctx.canvas.width / w : 1;
    T = BASES[normalizeBase(opts.base)];
    ctx.save();
    if (sc !== 1) ctx.scale(sc, sc);
    if (layout === 'B') drawB(ctx, w, h, o);
    else if (layout === 'C') drawC(ctx, w, h, o);
    else if (layout === 'I') drawI(ctx, w, h, o);
    else if (layout === 'J') drawJ(ctx, w, h, o);
    else if (layout === 'N') drawN(ctx, w, h, o);
    else if (layout === 'P') drawP(ctx, w, h, o);
    else if (layout === 'Q') drawQ(ctx, w, h, o);
    else if (layout === 'K') drawK(ctx, w, h, o);
    else if (layout === 'L') drawL(ctx, w, h, o);
    else if (layout === 'M') drawM(ctx, w, h, o);
    else drawA(ctx, w, h, o);
    ctx.restore();
    T = BASES.cream;
  }

  /** 由字串算出穩定的 32-bit 雜湊（FNV-1a），用來挑背景圖。 */
  function hash32(s) {
    let h = 0x811c9dc5;
    for (const ch of String(s)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  return {
    LAYOUTS, LAYOUT_NAMES, BASES, BASE_IDS, BASE_NAMES, normalizeBase, layoutsFor, layoutFor, SIZES, PIXEL_SIZES, PREVIEW_PIXELS, GREETINGS, GREETING_EN, SERIF, qrMatrix,
    draw, dateInfo, normalizeDate, normalizeLabel, LABELS, greetingForHour, zonedNow, normalizeGreeting, normalizeLayout, normalizeSize,
    packLines, fitText, clauses, sealText, hash32
  };
});
