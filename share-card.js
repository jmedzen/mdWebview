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
 * 兩種尺寸：portrait 1080×1350（直接傳圖）、og 1200×630（連結預覽）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShareCard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LAYOUTS = ['A', 'B', 'C'];
  const LAYOUT_NAMES = { A: '晨光留白', B: '沉浸全幅', C: '經籤直書' };
  const SIZES = { portrait: [1080, 1350], og: [1200, 630] };
  const GREETINGS = ['早安', '午安', '晚安'];
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

  function normalizeGreeting(g) { return GREETINGS.includes(g) ? g : '早安'; }
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
    return best || { size: minSize, lines: [String(text || '')] };
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
  const PAPER = '#f8f3e8', INK = '#2a2620', INK_SOFT = '#7a6a52', GOLD = '#b08d4a', RULE = '#d9ccb2';

  function drawA(ctx, w, h, o) {
    const land = w > h;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    if (!land) {
      const ih = Math.round(h * 0.58);
      drawCover(ctx, o.image, 0, 0, w, ih, 0.5, 0.45);
      const fade = ctx.createLinearGradient(0, ih * 0.55, 0, ih);
      fade.addColorStop(0, 'rgba(248,243,232,0)');
      fade.addColorStop(1, PAPER);
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
      ctx.fillStyle = GOLD;
      ctx.font = font(500, 26);
      drawSpaced(ctx, '◆ ◆ ◆', w / 2, ih + 30, 14, 'center');
      const fit = fitText(o.verse.text, { boxW: w - 180, boxH: h - ih - 290, maxSize: 66, minSize: 34, advance: 1.12, lead: 1.65, maxLines: 6 });
      ctx.fillStyle = INK;
      ctx.font = font(700, fit.size);
      let y = ih + 70 + fit.size;
      const blockH = fit.size + (fit.lines.length - 1) * fit.size * 1.65;
      const room = h - ih - 290;
      y += Math.max(0, (room - blockH) / 2);
      for (const line of fit.lines) { drawSpaced(ctx, line, w / 2, y, fit.size * 0.12, 'center'); y += fit.size * 1.65; }
      if (o.verse.source) {
        ctx.fillStyle = INK_SOFT;
        ctx.font = font(500, 30);
        drawSpaced(ctx, `——《${o.verse.source}》`, w / 2, y - fit.size * 1.65 + 72, 4, 'center');
      }
      // 頁尾
      ctx.fillStyle = RULE;
      ctx.fillRect(64, h - 140, w - 128, 1.5);
      ctx.fillStyle = '#8b7d68';
      ctx.font = font(500, 24);
      drawSpaced(ctx, `${o.siteName} · 每日經句`, 64, h - 74, 3);
      drawSeal(ctx, '吉祥', w - 64 - 64, h - 116, 64);
      return;
    }
    // 橫式：左圖右文
    const iw = Math.round(w * 0.5);
    drawCover(ctx, o.image, 0, 0, iw, h, 0.5, 0.5);
    const fade = ctx.createLinearGradient(iw * 0.6, 0, iw, 0);
    fade.addColorStop(0, 'rgba(248,243,232,0)');
    fade.addColorStop(1, PAPER);
    ctx.fillStyle = fade;
    ctx.fillRect(iw * 0.6, 0, iw * 0.4 + 1, h);
    const x0 = iw + 40, x1 = w - 64;
    ctx.fillStyle = INK;
    ctx.font = font(700, 72);
    const gw = drawSpaced(ctx, o.greeting, x0, 126, 8);
    ctx.fillStyle = INK_SOFT;
    ctx.font = font(500, 22);
    drawSpaced(ctx, `${o.date.dotted} ${o.date.week} · ${o.date.term}`, x0 + gw + 22, 124, 2);
    const fit = fitText(o.verse.text, { boxW: x1 - x0, boxH: 230, maxSize: 48, minSize: 26, advance: 1.11, lead: 1.6, maxLines: 5 });
    ctx.fillStyle = INK;
    ctx.font = font(700, fit.size);
    const blockH = fit.size + (fit.lines.length - 1) * fit.size * 1.6;
    let y = 190 + (250 - blockH) / 2 + fit.size;
    for (const line of fit.lines) { drawSpaced(ctx, line, x0, y, fit.size * 0.11); y += fit.size * 1.6; }
    if (o.verse.source) {
      ctx.fillStyle = INK_SOFT;
      ctx.font = font(500, 24);
      drawSpaced(ctx, `——《${o.verse.source}》`, x0, y - fit.size * 1.6 + 52, 3);
    }
    ctx.fillStyle = RULE;
    ctx.fillRect(x0, h - 108, x1 - x0, 1.5);
    ctx.fillStyle = '#8b7d68';
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
      drawSpaced(ctx, `${o.siteName} · 每日經句`, left, footY, 3);
      if (o.host) drawSpaced(ctx, o.host, right, footY, 2, 'right');
    });
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
    ctx.fillStyle = 'rgba(252,248,238,0.92)';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();
    ctx.strokeStyle = 'rgba(176,141,74,0.75)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    ctx.strokeStyle = 'rgba(176,141,74,0.4)';
    ctx.strokeRect(sx + 14, sy + 14, sw - 28, sh - 28);

    const padT = land ? 44 : 72, padB = land ? 40 : 64;
    const colTop = sy + padT, colBottom = sy + sh - padB;
    let x = sx + sw - (land ? 62 : 86);
    // 問候（紅）
    const gs = land ? 64 : 96;
    ctx.fillStyle = '#9c2f27';
    ctx.font = font(700, gs);
    drawVertical(ctx, o.greeting, x, colTop, gs, gs * 1.12);
    x -= gs * 0.5 + (land ? 26 : 36);
    // 日期
    const ds = land ? 20 : 28;
    ctx.fillStyle = INK_SOFT;
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
    ctx.fillStyle = INK;
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
      ctx.fillStyle = INK_SOFT;
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
      const label = `${o.siteName} · 每日經句${!land && o.host ? ' · ' + o.host : ''}`;
      if (land) drawSpaced(ctx, label, 60, h - 40, 6);
      else drawSpaced(ctx, label, w / 2, h - 44, 6, 'center');
    });
  }

  /**
   * 畫一張卡。ctx 是 2D context（瀏覽器或 @napi-rs/canvas 都可以），畫布大小要先設好。
   * opts: { layout, size, image, verse: { text, source }, greeting, date: 'YYYY-MM-DD', siteName, host }
   */
  function draw(ctx, opts) {
    const [w, h] = SIZES[normalizeSize(opts.size)];
    const o = {
      image: opts.image || null,
      verse: { text: String((opts.verse && opts.verse.text) || ''), source: String((opts.verse && opts.verse.source) || '').replace(/^《|》$/g, '') },
      greeting: normalizeGreeting(opts.greeting),
      date: dateInfo(opts.date),
      siteName: String(opts.siteName || 'mdWebview'),
      host: String(opts.host || '')
    };
    const layout = normalizeLayout(opts.layout);
    if (layout === 'B') drawB(ctx, w, h, o);
    else if (layout === 'C') drawC(ctx, w, h, o);
    else drawA(ctx, w, h, o);
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
    LAYOUTS, LAYOUT_NAMES, SIZES, GREETINGS, SERIF,
    draw, dateInfo, normalizeDate, greetingForHour, normalizeGreeting, normalizeLayout, normalizeSize,
    packLines, fitText, clauses, sealText, hash32
  };
});
