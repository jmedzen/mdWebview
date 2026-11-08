'use strict';
/**
 * lib/share-card-draw.js — 早安圖真正畫圖的那一段（v4.24.0）
 *
 * 給 lib/share-card-render-worker.js（工作執行緒）和 lib/share-card-server.js（工作執行緒不能用時的備援）共用：
 *   - 背景圖解碼：解碼後的圖留 IMAGE_CACHE_MAX 張；同一張圖同時有好幾個請求時只解碼一次
 *   - 背景圖縮圖（bg 變體）：原圖比畫 1620×2025 需要的大時，第一次用到就縮成「剛好蓋滿 1620×2025」的
 *     JPEG q90 存到 bgDir（檔名 = 原圖路徑＋修改時間＋大小的雜湊），之後（含重開機後）都解碼這份小的
 *   - 畫圖＋JPEG 編碼，回傳耗時
 *
 * 字型是整個行程共用的（@napi-rs/canvas 的 GlobalFonts），主執行緒註冊過，工作執行緒就看得到。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ShareCard = require('../share-card.js');

const IMAGE_CACHE_MAX = 8;
const JPEG_QUALITY = 88;
const PREVIEW_JPEG_QUALITY = 78;
const PREVIEW_WEBP_QUALITY = 72;   // 同畫質下 WebP 約比 JPEG 小 30%
const BG_JPEG_QUALITY = 90;
// 縮圖目標：所有版型的圖框都不超過整張卡，整張卡最大是直式 1620×2025（og 1200×630 也被它蓋住）
const BG_COVER = [
  Math.max(ShareCard.PIXEL_SIZES.portrait[0], ShareCard.PIXEL_SIZES.og[0]),
  Math.max(ShareCard.PIXEL_SIZES.portrait[1], ShareCard.PIXEL_SIZES.og[1])
];
// 原圖只比目標大一點點時不值得多存一份
const BG_MIN_SHRINK = 0.9;

/** 原圖 w×h 要縮成多大才剛好蓋滿 BG_COVER；不用縮回 null。 */
function bgVariantSize(w, h) {
  if (!w || !h) return null;
  const s = Math.max(BG_COVER[0] / w, BG_COVER[1] / h);
  if (s >= BG_MIN_SHRINK) return null;
  const up = (n) => Math.ceil(n - 1e-6);   // 浮點誤差（3000 × 0.675 = 2025.0000001）不多進一格
  return [Math.max(BG_COVER[0], up(w * s)), Math.max(BG_COVER[1], up(h * s))];
}

function bgVariantName(abs, st) {
  const h = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 24);
  return `${h}.jpg`;
}

async function writeAtomic(file, buf) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// 小型 LRU（Map 依插入順序）
function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}
function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * 建一個畫圖器。canvasMod = require('@napi-rs/canvas')。
 * stats 計數（測試與後台狀態用）：decodes（實際解碼次數）、variantsMade（新做的縮圖）、variantHits（用了已存的縮圖）。
 */
function createDrawer(canvasMod) {
  const imageCache = new Map();
  const imagePending = new Map();
  const stats = { decodes: 0, variantsMade: 0, variantHits: 0 };

  async function decodeBackground(abs, st, bgDir) {
    const variant = bgDir ? path.join(bgDir, bgVariantName(abs, st)) : '';
    if (variant) {
      try {
        const buf = await fs.promises.readFile(variant);
        stats.decodes++;
        const img = await canvasMod.loadImage(buf);
        stats.variantHits++;
        return img;
      } catch (_) { /* 還沒做或壞了：從原圖來 */ }
    }
    stats.decodes++;
    const img = await canvasMod.loadImage(await fs.promises.readFile(abs));
    const size = variant ? bgVariantSize(img.width, img.height) : null;
    if (!size) return img;
    try {
      const c = canvasMod.createCanvas(size[0], size[1]);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size[0], size[1]);
      const buf = await c.encode('jpeg', BG_JPEG_QUALITY);
      await writeAtomic(variant, buf);
      stats.variantsMade++;
      // 第一次也用縮好的那份，和之後每次畫出來的結果一致
      return await canvasMod.loadImage(buf);
    } catch (_) {
      return img;
    }
  }

  /** 解碼背景圖（有快取、同時多個請求只解一次）。讀不到回 null。 */
  async function loadPicImage(abs, bgDir) {
    if (!abs) return null;
    let st;
    try { st = await fs.promises.stat(abs); } catch (_) { return null; }
    const key = `${abs}|${st.mtimeMs}|${st.size}`;
    const hit = lruGet(imageCache, key);
    if (hit) return hit;
    if (imagePending.has(key)) return imagePending.get(key);
    const job = decodeBackground(abs, st, bgDir)
      .then(img => { lruSet(imageCache, key, img, IMAGE_CACHE_MAX); return img; }, () => null)
      .finally(() => imagePending.delete(key));
    imagePending.set(key, job);
    return job;
  }

  /**
   * 畫一張。job: { opts（ShareCard.draw 的參數，不含 image）, picAbs, bgDir, preview }
   * 回傳 { buf, decode, draw, encode }（毫秒）。
   */
  async function draw(job) {
    const opts = job.opts;
    const size = ShareCard.normalizeSize(opts.size);
    const layout = ShareCard.normalizeLayout(opts.layout);
    const preview = Boolean(job.preview) && size === 'portrait';
    const [w, h] = preview ? ShareCard.PREVIEW_PIXELS : ShareCard.PIXEL_SIZES[size];
    let t0 = Date.now();
    const image = job.picAbs ? await loadPicImage(job.picAbs, job.bgDir) : null;
    const decode = Date.now() - t0;
    t0 = Date.now();
    const canvas = canvasMod.createCanvas(w, h);
    ShareCard.draw(canvas.getContext('2d'), { ...opts, layout, size, image });
    const drawMs = Date.now() - t0;
    t0 = Date.now();
    const buf = preview && job.webp
      ? await canvas.encode('webp', PREVIEW_WEBP_QUALITY)
      : await canvas.encode('jpeg', preview ? PREVIEW_JPEG_QUALITY : JPEG_QUALITY);
    return { buf, decode, draw: drawMs, encode: Date.now() - t0 };
  }

  function clear() {
    imageCache.clear();
    imagePending.clear();
  }

  return { draw, loadPicImage, clear, stats };
}

module.exports = { createDrawer, bgVariantSize, bgVariantName, writeAtomic, lruGet, lruSet, BG_COVER };
