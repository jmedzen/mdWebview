/**
 * @file lib/report-chart.js — 報表信用的圖表：同一份圖形描述輸出 SVG 與 PNG
 *
 * 為什麼要兩種格式：Gmail、Outlook 不顯示 SVG（內嵌 <svg> 會被拿掉，SVG 圖檔也不顯示），
 * 所以寄出的信用 PNG（以 cid 內嵌），後台預覽則直接顯示 SVG。兩者由同一份「場景」
 * （矩形、折線、多邊形、圓點、文字）畫出，內容一致。
 *
 * PNG 由這個檔案自己點陣化，不引入任何套件：超取樣後縮小做反鋸齒，再以 zlib 壓縮。
 * 圖裡的文字只有數字與少數符號（座標軸刻度、日期），用內建的筆畫字型畫；中文標題與
 * 圖例一律放在信件 HTML 裡，不進圖片。
 */

const zlib = require('zlib');

// ── 筆畫字型（4×6 格，y 往下；只涵蓋刻度會用到的字元） ──────────────────
const GLYPHS = {
  '0': [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  '1': [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  '2': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  '3': [[[0, 0], [4, 0], [2, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [1, 6], [0, 5]]],
  '4': [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  '5': [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [0, 6]]],
  '6': [[[3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [3, 2.5], [0, 2.5]]],
  '7': [[[0, 0], [4, 0], [1.5, 6]]],
  '8': [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0]], [[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  '9': [[[4, 3.5], [1, 3.5], [0, 2.5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6]]],
  '/': [[[0.5, 6], [3.5, 0]]],
  ':': [[[2, 1.6], [2, 2.1]], [[2, 4.6], [2, 5.1]]],
  '-': [[[0.5, 3.5], [3.5, 3.5]]],
  '+': [[[2, 1.5], [2, 5.5]], [[0, 3.5], [4, 3.5]]],
  '.': [[[2, 5.5], [2, 6]]],
  ',': [[[2, 5.3], [1.4, 7]]],
  '%': [[[0, 6], [4, 0]], [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[3, 5], [4, 5], [4, 6], [3, 6], [3, 5]]],
  'k': [[[0, 0], [0, 6]], [[3.5, 2.5], [0, 4.6]], [[1.3, 3.8], [3.5, 6]]],
  'M': [[[0, 6], [0, 0], [2, 3.2], [4, 0], [4, 6]]],
  ' ': []
};
const GLYPH_ADVANCE = 5.4; // 字寬 4 + 字距

function glyphUnit(size) { return (size * 0.72) / 6; }

/** 文字寬度（chart 座標），SVG 與 PNG 都用這個算對齊。 */
function textWidth(text, size) {
  const n = String(text).length;
  return n ? (n * GLYPH_ADVANCE - (GLYPH_ADVANCE - 4)) * glyphUnit(size) : 0;
}

// ── 小工具 ───────────────────────────────────────────────
function parseColor(hex) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function round(n) { return Math.round(n * 100) / 100; }

/** 1.2k、3.4M：刻度與數值標籤用。 */
function formatShort(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

/** 取「好看」的 y 軸上限與刻度：1、2、2.5、5 × 10^n。 */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw) || 10 * pow;
  const finalStep = step < 1 ? 1 : step;
  return { max: Math.ceil(max / finalStep) * finalStep, step: finalStep };
}

// ── 圖表：時間序列（長條＋折線） ───────────────────────────────
/**
 * @param {object} o
 * @param {string[]} o.labels       x 軸標籤（只用數字與 / : -）
 * @param {Array<{values:number[], color:string, type:'bar'|'line', dashed?:boolean, area?:boolean}>} o.series
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @returns {{width:number, height:number, items:Array}}
 */
function timeChart({ labels, series, width = 600, height = 220, maxLabels = 12 }) {
  const items = [];
  const pad = { l: 40, r: 12, t: 14, b: 26 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = Math.max(1, labels.length);
  const all = series.flatMap(s => s.values.map(v => Number(v) || 0));
  const { max, step } = niceScale(Math.max(0, ...all));

  items.push({ t: 'rect', x: 0, y: 0, w: width, h: height, fill: '#ffffff' });
  // 格線與 y 刻度
  for (let v = 0; v <= max + 1e-9; v += step) {
    const y = pad.t + plotH - (v / max) * plotH;
    items.push({ t: 'line', points: [[pad.l, y], [width - pad.r, y]], stroke: v === 0 ? '#c9ced6' : '#eceef2', width: 1 });
    items.push({ t: 'text', x: pad.l - 6, y: y + 4, text: formatShort(v), size: 10, fill: '#8a919c', anchor: 'end' });
  }

  const slot = plotW / n;
  const xAt = i => pad.l + slot * (i + 0.5);
  const yAt = v => pad.t + plotH - ((Number(v) || 0) / max) * plotH;

  // x 標籤：太密時跳著標
  const every = Math.max(1, Math.ceil(n / maxLabels));
  labels.forEach((label, i) => {
    if (i % every !== 0) return;
    items.push({ t: 'text', x: xAt(i), y: height - 8, text: String(label), size: 10, fill: '#8a919c', anchor: 'middle' });
  });

  const bars = series.filter(s => s.type === 'bar');
  if (bars.length) {
    const groupW = Math.min(slot * 0.72, 46);
    const barW = groupW / bars.length;
    bars.forEach((s, bi) => {
      s.values.forEach((v, i) => {
        const val = Number(v) || 0;
        if (val <= 0) return;
        const x = xAt(i) - groupW / 2 + bi * barW;
        const y = yAt(val);
        items.push({ t: 'rect', x: x + 0.5, y, w: Math.max(1, barW - 1), h: pad.t + plotH - y, fill: s.color, r: Math.min(3, barW / 3) });
      });
    });
  }

  series.filter(s => s.type === 'line').forEach(s => {
    const pts = s.values.map((v, i) => [xAt(i), yAt(v)]);
    if (s.area && pts.length > 1) {
      items.push({ t: 'poly', points: [[pts[0][0], pad.t + plotH], ...pts, [pts[pts.length - 1][0], pad.t + plotH]], fill: s.color, opacity: 0.12 });
    }
    if (pts.length > 1) items.push({ t: 'line', points: pts, stroke: s.color, width: s.dashed ? 1.6 : 2.2, dash: s.dashed ? [5, 4] : null });
    if (!s.dashed && pts.length <= 31) {
      pts.forEach(([x, y]) => items.push({ t: 'circle', cx: x, cy: y, r: 2.8, fill: s.color }));
    }
  });

  return { width, height, items };
}

// ── SVG 輸出 ─────────────────────────────────────────────
function toSvg(scene) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" font-family="-apple-system,'Segoe UI',Roboto,'Noto Sans TC',sans-serif">`];
  for (const it of scene.items) {
    if (it.t === 'rect') {
      parts.push(`<rect x="${round(it.x)}" y="${round(it.y)}" width="${round(it.w)}" height="${round(it.h)}"${it.r ? ` rx="${round(it.r)}"` : ''} fill="${it.fill}"/>`);
    } else if (it.t === 'line') {
      parts.push(`<polyline points="${it.points.map(p => `${round(p[0])},${round(p[1])}`).join(' ')}" fill="none" stroke="${it.stroke}" stroke-width="${it.width}" stroke-linejoin="round" stroke-linecap="round"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''}/>`);
    } else if (it.t === 'poly') {
      parts.push(`<polygon points="${it.points.map(p => `${round(p[0])},${round(p[1])}`).join(' ')}" fill="${it.fill}"${it.opacity !== undefined ? ` fill-opacity="${it.opacity}"` : ''}/>`);
    } else if (it.t === 'circle') {
      parts.push(`<circle cx="${round(it.cx)}" cy="${round(it.cy)}" r="${it.r}" fill="${it.fill}"/>`);
    } else if (it.t === 'text') {
      const anchor = it.anchor === 'end' ? 'end' : it.anchor === 'middle' ? 'middle' : 'start';
      parts.push(`<text x="${round(it.x)}" y="${round(it.y)}" font-size="${it.size}" fill="${it.fill}" text-anchor="${anchor}">${escapeXml(it.text)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

// ── PNG 點陣化 ───────────────────────────────────────────
class Raster {
  constructor(width, height, k) {
    this.k = k;
    this.w = Math.ceil(width * k);
    this.h = Math.ceil(height * k);
    this.px = new Uint8Array(this.w * this.h * 3).fill(255);
  }

  blend(i, c, a) {
    const p = i * 3;
    if (a >= 1) {
      this.px[p] = c[0]; this.px[p + 1] = c[1]; this.px[p + 2] = c[2];
    } else {
      this.px[p] = this.px[p] + (c[0] - this.px[p]) * a;
      this.px[p + 1] = this.px[p + 1] + (c[1] - this.px[p + 1]) * a;
      this.px[p + 2] = this.px[p + 2] + (c[2] - this.px[p + 2]) * a;
    }
  }

  /** 以像素中心取樣填滿多邊形（非零環繞規則）；points 為 chart 座標。 */
  fillPolygon(points, color, alpha = 1) {
    const k = this.k;
    const pts = points.map(p => [p[0] * k, p[1] * k]);
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const c = parseColor(color);
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xa, ya] = pts[j];
        const [xb, yb] = pts[i];
        if ((ya <= sy && yb > sy) || (yb <= sy && ya > sy)) {
          xs.push({ x: xa + ((sy - ya) / (yb - ya)) * (xb - xa), d: yb > ya ? 1 : -1 });
        }
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a.x - b.x);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].d;
        if (wind === 0) continue;
        const xa = Math.max(0, Math.ceil(xs[i].x - 0.5));
        const xb = Math.min(this.w - 1, Math.floor(xs[i + 1].x - 0.5));
        for (let x = xa; x <= xb; x++) this.blend(y * this.w + x, c, alpha);
      }
    }
  }

  fillCircle(cx, cy, r, color, alpha = 1) {
    const k = this.k;
    const c = parseColor(color);
    const X = cx * k, Y = cy * k, R = r * k, R2 = R * R;
    for (let y = Math.max(0, Math.floor(Y - R)); y <= Math.min(this.h - 1, Math.ceil(Y + R)); y++) {
      for (let x = Math.max(0, Math.floor(X - R)); x <= Math.min(this.w - 1, Math.ceil(X + R)); x++) {
        const dx = x + 0.5 - X, dy = y + 0.5 - Y;
        if (dx * dx + dy * dy <= R2) this.blend(y * this.w + x, c, alpha);
      }
    }
  }

  fillRect(x, y, w, h, color, r = 0) {
    if (r > 0 && w > 2 * r && h > r) {
      // 只有上方兩角圓角（長條圖）
      this.fillRect(x, y + r, w, h - r, color);
      this.fillRect(x + r, y, w - 2 * r, r + 0.01, color);
      this.fillCircle(x + r, y + r, r, color);
      this.fillCircle(x + w - r, y + r, r, color);
      return;
    }
    this.fillPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color);
  }

  strokeSegment(a, b, width, color) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = (-dy / len) * width / 2, ny = (dx / len) * width / 2;
    this.fillPolygon([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], color);
  }

  strokePolyline(points, width, color, dash = null) {
    const segs = [];
    if (dash) {
      let on = true, left = dash[0], di = 0;
      for (let i = 0; i < points.length - 1; i++) {
        let [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        let remain = Math.hypot(bx - ax, by - ay);
        const ux = (bx - ax) / (remain || 1), uy = (by - ay) / (remain || 1);
        while (remain > 1e-6) {
          const step = Math.min(left, remain);
          const nx = ax + ux * step, ny = ay + uy * step;
          if (on) segs.push([[ax, ay], [nx, ny]]);
          ax = nx; ay = ny; remain -= step; left -= step;
          if (left <= 1e-6) { on = !on; di = (di + 1) % dash.length; left = dash[di]; }
        }
      }
    } else {
      for (let i = 0; i < points.length - 1; i++) segs.push([points[i], points[i + 1]]);
    }
    for (const [a, b] of segs) {
      this.strokeSegment(a, b, width, color);
      this.fillCircle(a[0], a[1], width / 2, color);
      this.fillCircle(b[0], b[1], width / 2, color);
    }
  }

  drawText(text, x, y, size, color, anchor) {
    const u = glyphUnit(size);
    const w = textWidth(text, size);
    let ox = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    const oy = y - 6 * u; // y 為基線
    const stroke = Math.max(0.9, size / 10);
    for (const ch of String(text)) {
      const strokes = GLYPHS[ch] || [];
      for (const line of strokes) {
        this.strokePolyline(line.map(([gx, gy]) => [ox + gx * u, oy + gy * u]), stroke, color);
      }
      ox += GLYPH_ADVANCE * u;
    }
  }
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * 點陣化成 PNG。scale=2 給高解析度螢幕；ss 為每軸超取樣倍數（反鋸齒）。
 * @returns {Buffer}
 */
function toPng(scene, { scale = 2, ss = 3 } = {}) {
  const r = new Raster(scene.width, scene.height, scale * ss);
  for (const it of scene.items) {
    if (it.t === 'rect') r.fillRect(it.x, it.y, it.w, it.h, it.fill, it.r || 0);
    else if (it.t === 'poly') r.fillPolygon(it.points, it.fill, it.opacity === undefined ? 1 : it.opacity);
    else if (it.t === 'line') r.strokePolyline(it.points, it.width, it.stroke, it.dash);
    else if (it.t === 'circle') r.fillCircle(it.cx, it.cy, it.r, it.fill);
    else if (it.t === 'text') r.drawText(it.text, it.x, it.y, it.size, it.fill, it.anchor);
  }
  // 縮小：每 ss×ss 個超取樣點平均成一個像素
  const W = Math.ceil(scene.width * scale);
  const H = Math.ceil(scene.height * scale);
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const n = ss * ss;
  for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let yy = 0; yy < ss; yy++) {
        const sy = Math.min(r.h - 1, y * ss + yy);
        for (let xx = 0; xx < ss; xx++) {
          const sx = Math.min(r.w - 1, x * ss + xx);
          const p = (sy * r.w + sx) * 3;
          sr += r.px[p]; sg += r.px[p + 1]; sb += r.px[p + 2];
        }
      }
      const o = rowStart + 1 + x * 3;
      raw[o] = Math.round(sr / n); raw[o + 1] = Math.round(sg / n); raw[o + 2] = Math.round(sb / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { timeChart, toSvg, toPng, niceScale, formatShort, textWidth, GLYPHS };
