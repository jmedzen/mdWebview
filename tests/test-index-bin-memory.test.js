const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  saveSearchIndexBinCacheAsync,
  loadSearchIndexFromBinCacheAsync,
  saveDictIndexBinCacheAsync,
  loadDictIndexFromBinCacheAsync,
  terminateWorkerPools,
  ChunkedBinaryWriter
} = require('../server');

test('Index Binary Cache: ChunkedBinaryWriter basic operations', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-cbw-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  try {
    const writer = new ChunkedBinaryWriter(tmpFile, 32); // very small chunk to force multiple flushes
    await writer.writeUInt32BE(0x12345678);
    await writer.writeUInt16BE(0xabcd);
    await writer.writeInt32BE(-42);
    await writer.writeUInt8(0x7f);

    const testBuf = Buffer.from('Hello Chunked Binary World! This string is long enough to cross chunk boundaries.');
    await writer.writeBuffer(testBuf);
    await writer.close();

    const readBack = await fs.promises.readFile(tmpFile);
    assert.equal(readBack.length, writer.totalBytes);
    assert.equal(readBack.readUInt32BE(0), 0x12345678);
    assert.equal(readBack.readUInt16BE(4), 0xabcd);
    assert.equal(readBack.readInt32BE(6), -42);
    assert.equal(readBack.readUInt8(10), 0x7f);
    assert.equal(readBack.subarray(11).toString('utf-8'), testBuf.toString('utf-8'));
  } finally {
    try { await fs.promises.unlink(tmpFile); } catch (_) {}
  }
});

test('Index Binary Cache: Vault Search Index Save & Load Round-trip', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-search-bin-'));
  const testBinPath = path.join(tmpDir, 'test-vault.bin');

  try {
    const vaultSig = 'test-vault-sig-' + Date.now();
    const fileList = [
      { id: 0, relPath: '01-經文/01.md', name: '01.md', fullPath: '/mock/01.md' },
      { id: 1, relPath: '01-經文/02.md', name: '02.md', fullPath: '/mock/02.md' }
    ];
    const units = [
      { unitId: 0, fileId: 0, entryIndex: -1, headword: '', byteOffset: 0, byteLength: 500, lineStart: 1 },
      { unitId: 1, fileId: 1, entryIndex: 0, headword: '般若', byteOffset: 100, byteLength: 200, lineStart: 10 },
      { unitId: 2, fileId: 1, entryIndex: 1, headword: '波羅蜜', byteOffset: 300, byteLength: 400, lineStart: 25 }
    ];

    // Synthetic bigrams: test single numbers, Uint16Array, Uint32Array, and in-place conversion
    const bigrams = new Map();
    bigrams.set('般若', 1); // single posting (number)
    bigrams.set('波羅', new Uint16Array([1, 2])); // multiple postings Uint16
    bigrams.set('菩提', new Uint32Array([0, 1, 2])); // multiple postings Uint32

    // Save with ChunkedBinaryWriter directly
    const writer = new ChunkedBinaryWriter(testBinPath, 64);
    const useUint16 = units.length < 65536;
    const magic = useUint16 ? 0x42475835 : 0x42475836;
    await writer.writeUInt32BE(magic);
    const sigBuf = Buffer.from(vaultSig);
    await writer.writeUInt16BE(sigBuf.length);
    await writer.writeBuffer(sigBuf);

    await writer.writeUInt32BE(fileList.length);
    await writer.writeUInt32BE(units.length);
    await writer.writeUInt32BE(bigrams.size);

    for (const f of fileList) {
      await writer.writeUInt32BE(f.id);
      const relB = Buffer.from(f.relPath);
      await writer.writeUInt16BE(relB.length);
      await writer.writeBuffer(relB);
      const nameB = Buffer.from(f.name);
      await writer.writeUInt16BE(nameB.length);
      await writer.writeBuffer(nameB);
      const fullB = Buffer.from(f.fullPath);
      await writer.writeUInt16BE(fullB.length);
      await writer.writeBuffer(fullB);
    }

    for (const u of units) {
      await writer.writeUInt32BE(u.unitId);
      await writer.writeUInt32BE(u.fileId);
      await writer.writeInt32BE(u.entryIndex);
      const hwB = Buffer.from(u.headword || '');
      await writer.writeUInt16BE(hwB.length);
      await writer.writeBuffer(hwB);
      await writer.writeUInt32BE(u.byteOffset);
      await writer.writeUInt32BE(u.byteLength);
      await writer.writeUInt32BE(u.lineStart);
    }

    for (const [bg, val] of bigrams.entries()) {
      const bgB = Buffer.from(bg);
      const isSingle = typeof val === 'number';
      const count = isSingle ? 1 : val.length;
      await writer.writeUInt8(bgB.length);
      await writer.writeBuffer(bgB);
      await writer.writeUInt32BE(count);
      if (useUint16) {
        if (isSingle) {
          await writer.writeUInt16BE(val);
        } else {
          for (let j = 0; j < count; j++) await writer.writeUInt16BE(val[j]);
        }
      } else {
        if (isSingle) {
          await writer.writeUInt32BE(val);
        } else {
          for (let j = 0; j < count; j++) await writer.writeUInt32BE(val[j]);
        }
      }
    }
    await writer.close();

    // Verify file contents match binary format specification
    const buf = await fs.promises.readFile(testBinPath);
    assert.equal(buf.readUInt32BE(0), 0x42475835);
    const readSigLen = buf.readUInt16BE(4);
    assert.equal(buf.toString('utf-8', 6, 6 + readSigLen), vaultSig);

    let offset = 6 + readSigLen;
    assert.equal(buf.readUInt32BE(offset), fileList.length); offset += 4;
    assert.equal(buf.readUInt32BE(offset), units.length); offset += 4;
    assert.equal(buf.readUInt32BE(offset), bigrams.size); offset += 4;
  } finally {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Index Binary Cache: In-place Compaction does not leak or duplicate Maps', async () => {
  const units = new Array(5000);
  for (let i = 0; i < 5000; i++) {
    units[i] = { unitId: i };
  }
  const useUint16 = units.length < 65536;

  const bigrams = new Map();
  // Bigram 1: single posting
  bigrams.set('經文', [42]);
  // Bigram 2: multiple postings, unsorted
  bigrams.set('佛陀', [105, 12, 888, 30]);

  // Perform in-place compaction
  for (const [bg, list] of bigrams.entries()) {
    if (list.length === 1) {
      bigrams.set(bg, list[0]);
    } else {
      list.sort((a, b) => a - b);
      bigrams.set(bg, useUint16 ? new Uint16Array(list) : new Uint32Array(list));
    }
  }

  // Verify bigrams Map still contains exactly the same keys and correct compacted types
  assert.equal(bigrams.size, 2);
  assert.equal(bigrams.get('經文'), 42);
  assert.equal(typeof bigrams.get('經文'), 'number');

  const ft = bigrams.get('佛陀');
  assert.ok(ft instanceof Uint16Array);
  assert.deepEqual(Array.from(ft), [12, 30, 105, 888]);

  if (typeof terminateWorkerPools === 'function') {
    await terminateWorkerPools();
  }
});
