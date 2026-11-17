/**
 * @file lib/tts-segment-worker.js — 大檔（≥ 1 MB）的朗讀斷句在這個 Worker 做，不卡主執行緒。
 * 每次工作開一個、做完就結束（斷句約每 MB 100 ms，結果由 lib/tts.js 快取在記憶體）。
 */
const { parentPort, workerData } = require('worker_threads');
const Seg = require('../tts-segment.js');

const d = Seg.segmentDoc(workerData.text, workerData.opts);
const c = Seg.detectChapters(d.units);
parentPort.postMessage({ units: d.units, stats: d.stats, layer: c.layer, chapters: c.chapters });
