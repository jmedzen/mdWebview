/**
 * @file lib/worker-pool.js — Worker Thread Pool Management (Render & Index Workers)
 */

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { APP_ROOT } = require('./constants');

const numCpus = os.cpus().length || 4;
const POOL_SIZE = Math.max(2, numCpus - 1);
const MAX_RENDER_QUEUE_LEN = POOL_SIZE * 8;
const workerPool = [];
const jobCallbacks = new Map(); // jobId -> { resolve, reject, timer }
let jobIdSeq = 0;
const jobQueue = []; // queue for when all workers are busy
let renderWorkerCrashTimes = [];
const JOB_TIMEOUT_MS = 30000; // 30 seconds

let loggerRef = console;
function setWorkerPoolLogger(logger) {
  if (logger) loggerRef = logger;
}

function respawnRenderWorker(index) {
  const now = Date.now();
  renderWorkerCrashTimes.push(now);
  renderWorkerCrashTimes = renderWorkerCrashTimes.filter(t => now - t < 15000);
  if (renderWorkerCrashTimes.length > 8) {
    if (loggerRef.error) loggerRef.error('WorkerPool', 'Render worker crash loop detected (>8 exits in 15s). Delaying respawn by 2s.');
    setTimeout(() => {
      const nw = createWorker(index);
      workerPool.push(nw);
      flushQueue();
    }, 2000);
  } else {
    const nw = createWorker(index);
    workerPool.push(nw);
    flushQueue();
  }
}

function createWorker(index) {
  const WORKER_PATH = path.join(APP_ROOT, 'render-worker.js');
  const w = new Worker(WORKER_PATH);
  w.idle = true;
  w.currentJobId = null;
  w.index = index;

  w.on('message', ({ jobId, html, error }) => {
    const cb = jobCallbacks.get(jobId);
    if (cb) {
      jobCallbacks.delete(jobId);
      if (cb.timer) clearTimeout(cb.timer);
      if (error) cb.reject(new Error(error));
      else cb.resolve(html);
    }
    w.currentJobId = null;
    w.idle = true;
    flushQueue();
  });

  w.on('error', (err) => {
    if (loggerRef.error) loggerRef.error('WorkerPool', `[Worker #${w.index}] Thread error`, err);
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        if (cb.timer) clearTimeout(cb.timer);
        cb.reject(err);
      }
      w.currentJobId = null;
    }
  });

  w.on('exit', (code) => {
    if (w.terminated) return;
    console.warn(`[Worker ${w.index}] Exited with code ${code}. Re-spawning...`);
    
    if (w.currentJobId) {
      const cb = jobCallbacks.get(w.currentJobId);
      if (cb) {
        jobCallbacks.delete(w.currentJobId);
        if (cb.timer) clearTimeout(cb.timer);
        cb.reject(new Error('Worker thread terminated unexpectedly'));
      }
      w.currentJobId = null;
    }
    
    const idx = workerPool.indexOf(w);
    if (idx !== -1) {
      workerPool.splice(idx, 1);
    }
    
    respawnRenderWorker(w.index);
  });

  return w;
}

function initWorkerPool() {
  if (workerPool.length > 0) return;
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = createWorker(i);
    workerPool.push(w);
  }
  console.log(`  Workers: ${POOL_SIZE} render thread(s) ready`);
}

function flushQueue() {
  if (jobQueue.length === 0) return;
  const freeWorker = workerPool.find(w => w.idle);
  if (!freeWorker) return;
  const job = jobQueue.shift();
  if (!jobCallbacks.has(job.jobId)) {
    return flushQueue();
  }
  freeWorker.currentJobId = job.jobId;
  freeWorker.idle = false;
  freeWorker.postMessage({ jobId: job.jobId, body: job.body, filePath: job.filePath, lineOffset: job.lineOffset });
}

function renderWithWorker(body, filePath, lineOffset, signal) {
  lineOffset = lineOffset || 0;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Render cancelled by client'));
    }

    if (jobQueue.length >= MAX_RENDER_QUEUE_LEN) {
      const err = new Error('Render queue overloaded (503)');
      err.code = 'QUEUE_FULL';
      err.statusCode = 503;
      return reject(err);
    }

    const jobId = ++jobIdSeq;
    const timer = setTimeout(() => {
      const cb = jobCallbacks.get(jobId);
      if (cb) {
        jobCallbacks.delete(jobId);
        cb.reject(new Error('Worker render timeout after 30s'));

        const qIdx = jobQueue.findIndex(item => item.jobId === jobId);
        if (qIdx !== -1) {
          jobQueue.splice(qIdx, 1);
        }

        const stuckWorker = workerPool.find(w => w.currentJobId === jobId);
        if (stuckWorker) {
          if (loggerRef.warn) loggerRef.warn('WorkerPool', `[Worker #${stuckWorker.index}] Timed out on job #${jobId}. Terminating & respawning worker...`);
          stuckWorker.terminated = true;
          try { stuckWorker.terminate(); } catch (_) {}
          const idx = workerPool.indexOf(stuckWorker);
          if (idx !== -1) workerPool.splice(idx, 1);
          respawnRenderWorker(stuckWorker.index);
        }
      }
    }, JOB_TIMEOUT_MS);

    let abortHandler = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && abortHandler) {
        try { signal.removeEventListener('abort', abortHandler); } catch (_) {}
        abortHandler = null;
      }
    };

    const wrappedResolve = (val) => { cleanup(); resolve(val); };
    const wrappedReject = (err) => { cleanup(); reject(err); };

    jobCallbacks.set(jobId, { resolve: wrappedResolve, reject: wrappedReject, timer });

    if (signal) {
      abortHandler = () => {
        cleanup();
        jobCallbacks.delete(jobId);
        const qIdx = jobQueue.findIndex(item => item.jobId === jobId);
        if (qIdx !== -1) jobQueue.splice(qIdx, 1);
        reject(new Error('Render cancelled by client'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const freeWorker = workerPool.find(w => w.idle);
    if (freeWorker) {
      freeWorker.currentJobId = jobId;
      freeWorker.idle = false;
      freeWorker.postMessage({ jobId, body, filePath, lineOffset });
    } else {
      jobQueue.push({ jobId, body, filePath, lineOffset });
    }
  });
}

// ── Index & Search Worker Pool (Persistent Worker Pool for index-worker.js) ──
const INDEX_POOL_SIZE = Math.max(2, Math.min((os.cpus().length || 4) - 1, 8));
const MAX_INDEX_QUEUE_LEN = INDEX_POOL_SIZE * 16;
const indexWorkerPool = [];
const indexJobCallbacks = new Map(); // jobId -> { resolve, reject, timeoutTimer }
let indexJobSeq = 0;
const indexJobQueue = []; // FIFO queue for pending index/search tasks
let indexWorkerCrashTimes = [];

function respawnIndexWorker(index) {
  const now = Date.now();
  indexWorkerCrashTimes.push(now);
  indexWorkerCrashTimes = indexWorkerCrashTimes.filter(t => now - t < 15000);
  if (indexWorkerCrashTimes.length > 8) {
    if (loggerRef.error) loggerRef.error('IndexWorkerPool', 'Index worker crash loop detected (>8 exits in 15s). Delaying respawn by 2s.');
    setTimeout(() => {
      const nw = createIndexWorker(index);
      indexWorkerPool.push(nw);
      flushIndexJobQueue();
    }, 2000);
  } else {
    const nw = createIndexWorker(index);
    indexWorkerPool.push(nw);
    flushIndexJobQueue();
  }
}

function createIndexWorker(index) {
  const WORKER_PATH = path.join(APP_ROOT, 'index-worker.js');
  const w = new Worker(WORKER_PATH);
  w.idle = true;
  w.currentJobId = null;
  w.index = index;

  w.on('message', (msg) => {
    const { jobId, ok, result, error } = msg;
    const cb = indexJobCallbacks.get(jobId);
    if (cb) {
      indexJobCallbacks.delete(jobId);
      if (cb.timeoutTimer) clearTimeout(cb.timeoutTimer);
      if (ok) cb.resolve(result);
      else cb.reject(new Error(error || 'index worker error'));
    }
    w.currentJobId = null;
    w.idle = true;
    flushIndexJobQueue();
  });

  w.on('error', (err) => {
    if (loggerRef.error) loggerRef.error('IndexWorkerPool', `[Worker #${w.index}] Thread error`, err);
    if (w.currentJobId) {
      const cb = indexJobCallbacks.get(w.currentJobId);
      if (cb) {
        indexJobCallbacks.delete(w.currentJobId);
        if (cb.timeoutTimer) clearTimeout(cb.timeoutTimer);
        cb.reject(err);
      }
      w.currentJobId = null;
    }
  });

  w.on('exit', (code) => {
    if (w.terminated) return;
    if (code !== 0) {
      console.warn(`[IndexWorker ${w.index}] Exited with code ${code}. Re-spawning...`);
    }
    if (w.currentJobId) {
      const cb = indexJobCallbacks.get(w.currentJobId);
      if (cb) {
        indexJobCallbacks.delete(w.currentJobId);
        if (cb.timeoutTimer) clearTimeout(cb.timeoutTimer);
        cb.reject(new Error(`Index worker thread terminated unexpectedly with code ${code}`));
      }
      w.currentJobId = null;
    }
    const idx = indexWorkerPool.indexOf(w);
    if (idx !== -1) {
      indexWorkerPool.splice(idx, 1);
    }
    respawnIndexWorker(w.index);
  });

  return w;
}

function initIndexWorkerPool() {
  if (indexWorkerPool.length > 0) return;
  for (let i = 0; i < INDEX_POOL_SIZE; i++) {
    const w = createIndexWorker(i);
    indexWorkerPool.push(w);
  }
  console.log(`  Workers: ${INDEX_POOL_SIZE} index/search thread(s) ready`);
}

function getIndexWorkerPool() {
  if (indexWorkerPool.length === 0) {
    initIndexWorkerPool();
  }
  return indexWorkerPool;
}

function flushIndexJobQueue() {
  if (indexJobQueue.length === 0) return;
  const pool = getIndexWorkerPool();
  const freeWorker = pool.find(w => w.idle);
  if (!freeWorker) return;
  const item = indexJobQueue.shift();
  if (!indexJobCallbacks.has(item.jobId)) {
    return flushIndexJobQueue();
  }
  dispatchIndexJobToWorker(freeWorker, item.jobId, item.message);
}

function dispatchIndexJobToWorker(worker, jobId, message) {
  worker.currentJobId = jobId;
  worker.idle = false;
  worker.postMessage({ jobId, ...message });
}

function executeIndexJob(type, payload, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (indexJobQueue.length >= MAX_INDEX_QUEUE_LEN) {
      const err = new Error('Index job queue overloaded (503)');
      err.code = 'QUEUE_FULL';
      err.statusCode = 503;
      return reject(err);
    }

    const pool = getIndexWorkerPool();
    const jobId = `idx-${++indexJobSeq}`;
    const message = { type, ...payload };

    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const cb = indexJobCallbacks.get(jobId);
        if (cb) {
          indexJobCallbacks.delete(jobId);
          cb.reject(new Error(`Index worker job #${jobId} timed out after ${timeoutMs}ms`));
          const qIdx = indexJobQueue.findIndex(item => item.jobId === jobId);
          if (qIdx !== -1) indexJobQueue.splice(qIdx, 1);
          const currentPool = getIndexWorkerPool();
          const stuckWorker = currentPool.find(w => w.currentJobId === jobId);
          if (stuckWorker) {
            if (loggerRef.warn) loggerRef.warn('IndexWorkerPool', `[Worker #${stuckWorker.index}] Timed out on job #${jobId}. Terminating & respawning worker...`);
            stuckWorker.terminated = true;
            try { stuckWorker.terminate(); } catch (_) {}
            const idx = currentPool.indexOf(stuckWorker);
            if (idx !== -1) currentPool.splice(idx, 1);
            respawnIndexWorker(stuckWorker.index);
          }
        }
      }, timeoutMs);
    }

    const wrappedResolve = (val) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(val);
    };
    const wrappedReject = (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reject(err);
    };

    indexJobCallbacks.set(jobId, { resolve: wrappedResolve, reject: wrappedReject, timeoutTimer });

    const freeWorker = pool.find(w => w.idle);
    if (freeWorker) {
      dispatchIndexJobToWorker(freeWorker, jobId, message);
    } else {
      indexJobQueue.push({ jobId, message });
    }
  });
}

async function runIndexWorkerPool(tasks, buildMessage, onMessage, concurrency) {
  if (!tasks || tasks.length === 0) return;
  const pool = getIndexWorkerPool();
  const poolCapacity = pool.length || INDEX_POOL_SIZE;
  const limit = Math.max(1, Math.min(concurrency || poolCapacity, poolCapacity));
  let taskIdx = 0;
  let activeError = null;

  async function workerRunner() {
    while (taskIdx < tasks.length && !activeError) {
      const curIdx = taskIdx++;
      const task = tasks[curIdx];
      const msg = buildMessage(task);
      try {
        const result = await executeIndexJob(msg.type, msg.payload);
        onMessage(result, task);
      } catch (err) {
        activeError = err;
        throw err;
      }
    }
  }

  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push(workerRunner());
  }
  await Promise.all(runners);
}

async function terminateWorkerPools() {
  const promises = [];
  if (Array.isArray(workerPool)) {
    for (const w of workerPool) {
      w.terminated = true;
      try { promises.push(w.terminate()); } catch (_) {}
    }
  }
  if (Array.isArray(indexWorkerPool)) {
    for (const w of indexWorkerPool) {
      w.terminated = true;
      try { promises.push(w.terminate()); } catch (_) {}
    }
  }
  await Promise.allSettled(promises);
}

// Automatically initialize worker pools at boot
initWorkerPool();
initIndexWorkerPool();

module.exports = {
  workerPool,
  indexWorkerPool,
  initWorkerPool,
  initIndexWorkerPool,
  getIndexWorkerPool,
  renderWithWorker,
  executeIndexJob,
  runIndexWorkerPool,
  terminateWorkerPools,
  setWorkerPoolLogger
};
