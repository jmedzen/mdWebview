/**
 * 早安圖背景圖：每一張（包括剛新增的）被挑中的機率要一樣。
 *
 * 模擬器在 tools/sim-pic-pick.js（`node tools/sim-pic-pick.js --help`），這裡用同一批函式當回歸測試：
 *   - pickPic 對「經句代號 × 日期」的分布要像真的亂數（各種張數、固定的兩批經句代號、連續兩年的日期）
 *   - 圖庫新增一張（排在最前、中間、最後、或新子資料夾）：不到 1 分鐘的快取期限內看不到，過了就在清單裡，
 *     被挑中的機率是 1/(N+1)，其餘圖維持平均
 *   - 負向對照：挑圖若漏掉新圖（例如拿到舊清單），模擬器要抓得出來
 * 輸入都是固定的（SHA-1 算出的代號、連續日期），結果可重現，不會偶爾失敗。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const sc = require('../lib/share-card-server');
const sim = require('../tools/sim-pic-pick');

/** 10 碼十六進位代號，格式同 lib/home.js verseId()。 */
function ids(n, tag) {
  return Array.from({ length: n }, (_, i) => crypto.createHash('sha1').update(`${tag}-${i}`).digest('hex').slice(0, 10));
}
const SET_A = ids(467, 'synthetic-verse');   // 467 = 現行每日經句選集的句數
const SET_B = ids(467, 'other');
const DATES = sim.dateRange(730);

/** |z| 超過這個值（雙尾 p ≈ 7e-6）就當作不均勻；太均勻（像格子）也算。 */
const Z_LIMIT = 4.5;

describe('sim-pic-pick：統計小工具', () => {
  test('卡方：完全平均 → 0；一邊獨大 → p 很小', () => {
    const flat = sim.chiSquare([10, 10, 10, 10]);
    assert.equal(flat.chi2, 0);
    assert.ok(flat.p > 0.99);
    const skew = sim.chiSquare([100, 10, 10, 10, 10, 10]);
    assert.ok(skew.p < 1e-6, `p=${skew.p}`);
    assert.ok(Math.abs(sim.normalCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(sim.normalCdf(1.96) - 0.975) < 1e-3);
  });
});

describe('pickPic：每張圖機率一樣', () => {
  test('各種張數（含 2 的次方、質數）× 固定兩批經句 × 兩年日期，分布像真亂數', () => {
    for (const [name, set] of [['A', SET_A], ['B', SET_B]]) {
      for (const n of [32, 53, 54, 64, 128, 512]) {
        const list = Array.from({ length: n }, (_, i) => `p${i}.png`);
        const run = sim.countPicks(list, set, DATES);
        assert.equal(run.none, 0);
        const st = sim.summarize(list, run);
        assert.ok(Math.abs(st.z) < Z_LIMIT, `經句 ${name}、${n} 張：χ²=${st.chi2.toFixed(1)} df=${st.df} z=${st.z.toFixed(2)}`);
        // 最多與最少的差距也要在合理範圍（每張約 340910/n 次，離期望值 ±5σ 以內）
        const worst = Math.max(...st.arr.map(c => Math.abs(sim.sigmaOf(c, run.total, n))));
        assert.ok(worst < 5, `經句 ${name}、${n} 張：最偏的一張離期望值 ${worst.toFixed(2)}σ`);
      }
    }
  });

  test('排在清單前半與後半的圖，被挑中的總機率一樣', () => {
    const list = Array.from({ length: 54 }, (_, i) => `p${i}.png`);
    const run = sim.countPicks(list, SET_A, DATES);
    const st = sim.summarize(list, run);
    const p = st.expectedFirstHalfShare;
    const sd = Math.sqrt(p * (1 - p) / run.total);
    assert.ok(Math.abs(st.firstHalfShare - p) < 4.5 * sd, `前半 ${st.firstHalfShare}，期望 ${p}`);
  });

  test('只有一張圖時一定挑它；挑的一定是清單裡的那一項', () => {
    assert.equal(sc.pickPic(['only.png'], 'abc', '2026-11-09'), 'only.png');
    const list = ['a.png', 'b/c.png', 'd.webp'];
    for (const id of SET_A.slice(0, 50)) assert.ok(list.includes(sc.pickPic(list, id, '2026-11-09')));
  });
});

describe('圖庫新增一張圖後', () => {
  const names = sim.fakePicNames(53);   // 53 張 = 現在 pic-card/ 的張數

  for (const where of ['last', 'first', 'middle', 'folder']) {
    test(`新圖排在「${where}」：1 分鐘內看不到、過了看得到，被挑中的機率 = 1/(N+1)，其餘維持平均`, async () => {
      const { before, after } = await sim.simulate({ names, ids: SET_A, dates: DATES, add: where });
      assert.equal(before.list.length, 53);
      assert.ok(Math.abs(before.stats.z) < Z_LIMIT, `新增前 z=${before.stats.z.toFixed(2)}`);

      assert.equal(after.seenBeforeTtl, false, '快取期限內不重掃：清單還是舊的（最多每分鐘重掃一次）');
      assert.equal(after.seenAfterTtl, true, '過了期限，新圖一定要在清單裡');
      assert.equal(after.list.length, 54);
      assert.ok(after.list.includes(after.newPic));

      assert.ok(after.newCount > 0, '新圖從來沒被挑中');
      assert.ok(Math.abs(after.newSigma) < 4, `新圖被挑中 ${after.newCount} 次（${(after.newShare * 100).toFixed(3)}%），期望 ${(100 / 54).toFixed(3)}%，差 ${after.newSigma.toFixed(2)}σ`);
      assert.ok(Math.abs(after.newShare * 54 - 1) < 0.1, `新圖的機率是平均的 ${(after.newShare * 54).toFixed(3)} 倍`);
      assert.ok(Math.abs(after.stats.z) < Z_LIMIT, `新增後 z=${after.stats.z.toFixed(2)}`);
    });
  }

  test('負向對照：挑圖漏掉新圖（拿著舊清單）時，模擬器抓得到', async () => {
    const { after } = await sim.simulate({ names, ids: SET_A.slice(0, 100), dates: DATES.slice(0, 200), add: 'last' });
    const stale = after.list.slice(0, -1);                       // 舊清單：沒有新圖
    const run = sim.countPicks(after.list, SET_A.slice(0, 100), DATES.slice(0, 200), (list, id, d) => sc.pickPic(stale, id, d));
    assert.equal(run.counts.get(after.newPic), 0);
    const st = sim.summarize(after.list, run);
    assert.ok(sim.sigmaOf(0, run.total, after.list.length) < -4, '新圖 0 次要被判成偏低');
    assert.ok(st.p < 1e-3 || st.z > Z_LIMIT, `卡方沒抓到：z=${st.z.toFixed(2)}`);

    // 偏袒前半的挑法也要抓得到
    const biased = sim.countPicks(after.list, SET_A, DATES, (list, id, d) => {
      const h = crypto.createHash('sha1').update(`${id}|${d}`).digest().readUInt32BE(0);
      return list[(h % 3 === 0 ? h % list.length : h % Math.floor(list.length / 2))];
    });
    assert.ok(sim.summarize(after.list, biased).z > 10);
  });
});
