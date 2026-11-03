'use strict';
/**
 * lib/share-card-render-worker.js — 早安圖的畫圖工作執行緒（v4.24.0）
 *
 * 畫圖（ShareCard.draw）是同步的，8 張放在主執行緒上會讓整個網站卡 0.4–1.6 秒；
 * 搬到這裡後主執行緒只收發訊息。由 lib/share-card-server.js 建立與管理。
 *
 * 收：{ id, job: { opts, picAbs, bgDir, preview } } 或 { id, cmd: 'clear' }
 * 回：{ id, ok: true, buf: ArrayBuffer, decode, draw, encode, stats } 或 { id, ok: false, error }
 */

const { parentPort } = require('worker_threads');
const { createDrawer } = require('./share-card-draw');

const drawer = createDrawer(require('@napi-rs/canvas'));

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  if (msg.cmd === 'clear') {
    drawer.clear();
    parentPort.postMessage({ id: msg.id, ok: true, stats: { ...drawer.stats } });
    return;
  }
  try {
    const r = await drawer.draw(msg.job);
    // 取出 JPEG 的那段記憶體，轉移（transfer）給主執行緒
    const ab = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.length);
    parentPort.postMessage({ id: msg.id, ok: true, buf: ab, decode: r.decode, draw: r.draw, encode: r.encode, stats: { ...drawer.stats } }, [ab]);
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err), stats: { ...drawer.stats } });
  }
});
