/** 產生 commentary-data.js：從語料抽 CBETA 交叉參照，做成註疏譜系。 */
const fs = require('fs');
const pairs = require('/tmp/cf-pairs.json');
const tree = require('/tmp/tree.json');

// 建立 經號 → {name, path} 索引
const files = {};
(function walk(ns) {
  for (const n of ns || []) {
    if (n.type === 'file') {
      const m = n.name.match(/^(T\d+)《/);
      if (m) files[m[1]] = { name: n.name.replace(/\.md$/, ''), path: n.path };
    }
    if (n.children) walk(n.children);
  }
})(tree);

/**
 * 從註疏檔案開頭抽「作者署名」。
 *
 * CBETA 的署名行格式固定：**以動詞結尾**，緊接在經題之後。
 *
 *   隋天台智者大師說
 *   京大興福寺沙門宗密述
 *   勅隨駕講論沙門道氤集
 *   大慈恩寺沙門窺基撰
 *   唐翻經沙門法藏述
 *   天台智者大師記
 *   沙門　測撰
 *
 * 第一版寫壞了：沒有先跳過經題行，結果把「金剛般若經」「維摩義」這種
 * 經名當成作者（因為 `疏`、`義` 也被我列進動詞表）。經題就在 `No.` 行的
 * 下一行，一定要先跳過。
 *
 * 另外 `譯` 要排除：那是底本的譯者（如「三藏法師鳩摩羅什譯」），不是
 * 註疏的作者。真正的作者在下一行（「西有沙門蕅益智旭解」）。
 */
const AUTHOR_VERB_RE = /(撰|述|說|記|集|解|造|鈔|科|頌)$/;

/** 這些不是朝代，是宗派／寺院的修飾語，不該當成 era 顯示。 */
const NOT_ERA_RE = /^(大乘|小乘|京|西有|西湖|長水|天台|嘉祥|敕|勅|御|新羅|高麗|日本)/;

const ERA_RE = /^(後秦|姚秦|元魏|北魏|東魏|劉宋|蕭齊|南齊|梁|陳|隋|唐|後唐|宋|南宋|北宋|遼|金|元|明|清|民國|吳|西晉|東晉|晉|漢|後漢|前秦|北周|北齊)(?![朝])/;

function readAuthor(fullPath) {
  let lines;
  try {
    lines = fs.readFileSync(fullPath, 'utf8').split('\n');
  } catch (_) {
    return { by: '', era: '', attribution: '' };
  }

  let titleSkipped = false;
  let fallback = null;

  for (let i = 0; i < Math.min(lines.length, 22); i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('//')) continue;
    if (/^No\.\s*\d/.test(line)) continue;

    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) line = line.replace(/^#{1,6}\s*/, '').trim();

    // 緊接在 No. 行後的第一個非註解行是經題，跳過
    if (!titleSkipped && !isHeading) { titleSkipped = true; continue; }
    if (!titleSkipped && isHeading) titleSkipped = true;   // 標題寫成 ## 時，這一行本身就是經題

    if (line.length > 34) continue;        // 署名行不會長
    if (line.length < 3) continue;
    if (/^[，。、；：]/.test(line)) continue;

    // 去掉行內全角空白
    const norm = line.replace(/[\u3000\s]+/g, ' ').trim();

    if (AUTHOR_VERB_RE.test(norm)) {
      // 「譯」不是作者署名，但可能是 fallback（有些檔案只有譯者）
      const parsed = parseAttribution(norm);
      if (parsed.by) return parsed;
      if (!fallback) fallback = parsed;
    }
  }

  return fallback || { by: '', era: '', attribution: '' };
}

/**
 * 把署名行拆成 era / by / 原文。
 *
 * 原文一律保留（`attribution`）——拆不出來時，UI 至少還能顯示完整署名，
 * 不會變成空白。
 */
function parseAttribution(line) {
  const attribution = line;
  let rest = line;

  // 去掉結尾的動詞
  const verbM = rest.match(AUTHOR_VERB_RE);
  if (verbM) rest = rest.slice(0, -verbM[1].length).trim();

  let era = '';
  const eraM = rest.match(ERA_RE);
  if (eraM && !NOT_ERA_RE.test(rest)) {
    era = eraM[1];
    rest = rest.slice(era.length).trim();
  }

  // 去掉常見的職銜前綴，只留人名
  // 「京大興福寺沙門宗密」→「宗密」；「唐翻經沙門法藏」→「法藏」
  let by = rest;
  const monkM = by.match(/沙門\s*(.+)$/);
  if (monkM) by = monkM[1].trim();
  // 「勅隨駕講論沙門道氤」已在上一步處理

  // 修飾語（大乘／小乘／寺名／法師）留在名字前面沒有意義，去掉
  by = by.replace(/^(大乘|小乘)\s*/, '').trim();
  // 「京兆慈恩寺基法師」→「基」；「西湖靈芝崇福寺釋元照」→「釋元照」
  const templeM = by.match(/^.{0,10}?寺\s*(.+)$/);
  if (templeM) by = templeM[1].trim();
  by = by.replace(/法師$/, '').trim();

  /*
   * 收尾的健壯性檢查。
   *
   * 走到這裡還可能留下經名（「般若波羅蜜多心經註」被當成人名）。判準：
   * 人名不會含「經」「論」「疏」「品」「卷」這些字。含了就放棄，只留
   * 完整署名給 UI 顯示——寧可顯示原文，不要顯示錯的人。
   */
  /*
   * 單字人名（「基」「測」）是 CBETA 原文的省稱，但單獨顯示會被當成
   * 打字錯誤。這種情況保留完整署名（「大乘 基撰」），語境自己會說明。
   */
  if (by && by.length === 1) {
    return { by: '', era: era, attribution: attribution };
  }
  if (!by || by.length < 1 || by.length > 14) {
    return { by: '', era: era, attribution: attribution };
  }
  if (/[經論疏品卷記述贊鈔科]/.test(by)) {
    return { by: '', era: era, attribution: attribution };
  }
  // 只剩修飾語的情況（「大慈恩寺」「西湖靈芝崇福寺」）
  if (/寺$|院$/.test(by)) {
    return { by: '', era: era, attribution: attribution };
  }

  return { by: by, era: era, attribution: attribution };
}

// 底本經號 → 註疏清單（只留找得到底本的）
const out = [];
for (const baseNum of Object.keys(pairs)) {
  const baseId = 'T' + String(baseNum).padStart(4, '0');
  const base = files[baseId];
  if (!base) continue;   // 底本不在語料裡，這組就沒有意義

  const comms = pairs[baseNum]
    .map(c => {
      const id = c.name.match(/^(T\d+)《/);
      if (!id) return null;
      const meta = readAuthor(c.path);
      return {
        id: id[1],
        path: c.path,
        name: c.name.replace(/\.md$/, ''),
        by: meta.by,
        era: meta.era,
        attribution: meta.attribution
      };
    })
    .filter(Boolean)
    // 去掉自我參照（底本自己也有 cf 時）
    .filter(c => c.id !== baseId);

  if (comms.length < 2) continue;   // 只有一部註疏稱不上「譜系」

  out.push({
    base: { id: baseId, name: base.name, path: base.path },
    commentaries: comms.sort((a, b) => a.id.localeCompare(b.id))
  });
}

// 依註疏數量排序，最多的先
out.sort((a, b) => b.commentaries.length - a.commentaries.length);

const js = `/**
 * @file commentary-data.js
 *
 * 註疏譜系資料（alpha 批次 8）。
 *
 * ── 這份資料怎麼來的
 *
 * 不是猜的，也不是我列的清單。CBETA 在每一部註疏的開頭標了它註的是哪
 * 部經，格式固定：
 *
 *   No. 1710 [cf. No. 251]
 *
 * 意思是「這部是 T1710，對應 T0251」。掃過全部 7,222 個檔案，234 個有
 * 這個標記，去掉底本不在語料裡的、去掉只有一部註疏的，剩 ${out.length} 組。
 *
 * ── 為什麼要有這個
 *
 * 讀完一部經，最自然的下一個問題是「所以這部經到底是什麼意思」。這個
 * 站有兩千多部註疏，卻沒有任何一條路從經文通往它們——你得先知道「金剛
 * 經有十七部註疏」這件事，才有辦法去找。
 *
 * 這份資料把那個連結接上：讀金剛經讀到卷末，可以直接看到十七部註解，
 * 從天台智者到民國的江味農。
 *
 * ── 由 scripts/gen-commentaries.js 產生，不要手改
 *
 * 重新產生：node scripts/gen-commentaries.js
 */
(function (global) {
  'use strict';

  var FAMILIES = ${JSON.stringify(out, null, 1)};

  global.CommentaryData = {
    families: FAMILIES,
    /** 依底本經號找註疏組。 */
    forBase: function (id) {
      for (var i = 0; i < FAMILIES.length; i++) {
        if (FAMILIES[i].base.id === id) return FAMILIES[i];
      }
      return null;
    }
  };

})(typeof window !== 'undefined' ? window : this);
`;

fs.writeFileSync('commentary-data.js', js);
console.log('組數:', out.length, '| 註疏總數:', out.reduce((s, f) => s + f.commentaries.length, 0));
console.log('檔案大小:', (js.length / 1024).toFixed(0) + 'KB');
out.slice(0, 6).forEach(f => console.log('  ' + f.base.name.slice(0, 34).padEnd(36) + f.commentaries.length + ' 部'));
