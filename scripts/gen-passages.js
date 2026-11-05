/**
 * @file scripts/gen-passages.js
 *
 * 建立「經文流」資料（alpha 批次 11）。
 *
 * ── 為什麼要這份資料
 *
 * 首頁現在是一個啟動器：一朵蓮花、一個搜尋框、六個小晶片。前十個批次
 * 做的東西全在那六個晶片裡，而使用者打開的第一個畫面，沒有一行經文
 * 可讀。
 *
 * 一個佛典閱讀器的首頁不讀經，是本末倒置。
 *
 * ── 這份資料是什麼
 *
 * 從語料裡挑出「一段話本身就讀得懂」的經文段落，讓首頁可以像翻一本
 * 書那樣，往下讀就是下一段。
 *
 * 不是抽句——抽句是斷的（「色不異空，空不異色」單獨看很美，前後卻
 * 沒有上下文）。這裡要的是完整的段落：有主詞、有動作、意思自足。
 *
 * ── 挑選規則
 *
 *   1. 漢字 34～150 字。少於 34 字多半是「佛告須菩提：」這種過場；
 *      多於 150 字在手機上會變成一堵牆。
 *   2. 必須是完整段落（開頭不是接續詞，結尾有句末標點）。
 *   3. 不能是科判、目錄、卷首資訊（「第二、廣答。」那種）。
 *   4. 不能是表格、咒語羅列、純名相堆疊。
 *   5. 同一個檔案最多取 3 段，避免整條流都來自《大般若經》。
 *
 * 輸出格式刻意壓到最小：每段只留檔案路徑、行號、內文。行號是給
 * window.mdwOpenFile(path, line) 用的——點一段就跳到原文那個位置，
 * 不是回到檔案開頭。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD_ROOT = path.join(ROOT, 'md');
const OUT = path.join(ROOT, 'passages-data.js');

const MIN_HANZI = 34;
const MAX_HANZI = 150;
const MAX_PER_FILE = 3;
const TARGET = 420;          // 夠首頁連續讀很久，又不至於讓檔案太大

/** 只算漢字，標點與空格不算。 */
function hanziCount(s) {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

/**
 * 明顯不是「一段可讀經文」的東西。
 *
 * 這些是實際掃描語料後抓出來的類別，不是憑空想的：
 *   - 科判編號：「第二、廣答。」「初、標章。」
 *   - 目錄行：「一、序分 二、正宗分」
 *   - 咒語與音譯堆疊：「唵 阿 吽」「南無喝囉怛那…」
 *   - 校勘與版本註記：「〔一〕」「(宋)(元)」
 */
const REJECT_PATTERNS = [
  /^第?[一二三四五六七八九十百]+[、，,]/,
  /^[初次後][、，,]/,
  /^[○◎●※]/,
  /^\s*[（(]\s*[一二三四五六七八九十\d]+\s*[)）]/,
  /〔[^〕]*〕/,
  /[（(](宋|元|明|宮|麗|金|清|大|乙|三|敦|磧)[)）]/,
  /^(卷|No\.|CBETA|大正藏|中華電子佛典)/,
];

/** 開頭是接續詞：代表它接著上一句，單獨拿出來會沒頭沒尾。 */
const CONTINUE_START = /^(是故|所以|何以故|若復|復次|又復|如是|其中|於中|此中|今|然則|故知|由是)/;

/** 結尾必須是句末標點，否則就是被切斷的半句。 */
const END_OK = /[。！？」』：]$/;

function isCandidate(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('//')) return false;
  if (/^#/.test(t)) return false;

  const n = hanziCount(t);
  if (n < MIN_HANZI || n > MAX_HANZI) return false;

  for (const re of REJECT_PATTERNS) if (re.test(t)) return false;
  if (CONTINUE_START.test(t)) return false;
  if (!END_OK.test(t)) return false;

  /*
   * 音譯咒語的特徵：實詞極少、單字重複度高。
   * 用「相異字數 / 總字數」當指標，正常中文段落約 0.55 以上，
   * 咒語會低到 0.3 左右。
   */
  const chars = t.replace(/[^\u4e00-\u9fff]/g, '');
  if (chars.length > 0) {
    const ratio = new Set(chars).size / chars.length;
    if (ratio < 0.34) return false;
  }

  // 表格與欄位對齊殘留
  if ((t.match(/[│|｜]/g) || []).length > 0) return false;

  /*
   * 殘缺文字。
   *
   * CBETA 有些經本本身就有大量缺字（□ 或空白方格），例如
   * T0388《大雲無想經》整段是「盲今已□□□□□□…」。那種段落擺在
   * 首頁只會讓人以為網站壞了。
   */
  const missing = (t.match(/[□◻◼▢]/g) || []).length;
  if (missing >= 3) return false;
  if (missing > 0 && missing / t.length > 0.04) return false;

  /*
   * 名相堆疊。
   *
   * 「寶明菩薩、慧聚菩薩、勝藏菩薩、名稱意菩薩…」整段都是菩薩名號，
   * 資訊量很低，讀起來像名單。判斷法：頓號密度過高，且「菩薩」
   * 「比丘」「天」這類詞佔比大。
   */
  const enumMarks = (t.match(/[、]/g) || []).length;
  if (enumMarks >= 6 && enumMarks / (t.length / 10) > 1.6) return false;

  return true;
}

/** 走訪 md/ 找 .md。 */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 從檔名取經號與經名，例如 T0235《金剛般若波羅蜜經》。 */
/** 從檔名取經號與經名，例如 T0235《金剛般若波羅蜜經》。 */
function describe(filePath) {
  const base = path.basename(filePath, '.md');
  const m = base.match(/^(T\d{4})[《(](.+?)[》)]/);
  if (!m) return null;
  return { id: m[1], title: m[2] };
}

/**
 * 註疏不是經文。
 *
 * 首頁的經文流要給的是「佛說了什麼」，不是「某人怎麼解」。註疏雖然
 * 也在大正藏裡、也有經號，但它的段落是解釋體（「述云」「仙記云」
 * 「此云」），單獨擺在首頁會讓第一次來的人以為經文長這樣。
 *
 * 判斷靠經名——CBETA 的命名相當一致：釋、疏、註、述記、贊述、義記、
 * 玄義、科、鈔、論（論是論典，不是經）。
 *
 * 這不是完美的分類，但寧可少收，不要讓一條經文流裡混進解釋文。
 */
const COMMENTARY_TITLE = /(疏|註|注|述記|贊述|略釋|義記|玄義|科文|鈔|講義|會解|纂要|直解|句解|論$|釋$)/;

function isCommentaryWork(title) {
  return COMMENTARY_TITLE.test(title);
}

function main() {
  if (!fs.existsSync(MD_ROOT)) {
    console.error('找不到 md/ 目錄');
    process.exit(1);
  }

  const files = walk(MD_ROOT, []).filter(f => /T\d{4}[《(]/.test(path.basename(f)));
  console.log('掃描檔案:', files.length);

  const picked = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }

    const info = describe(file);
    if (!info) continue;
    if (isCommentaryWork(info.title)) continue;

    // 相對路徑，不含 md/ 前綴（與前端 openFile 的慣例一致）
    const rel = path.relative(MD_ROOT, file).split(path.sep).join('/');

    const lines = text.split('\n');
    let taken = 0;

    for (let i = 0; i < lines.length && taken < MAX_PER_FILE; i++) {
      if (!isCandidate(lines[i])) continue;

      picked.push({
        p: rel,
        l: i + 1,
        id: info.id,
        t: info.title,
        x: lines[i].trim(),
      });
      taken++;
    }
  }

  console.log('候選段落:', picked.length);

  /*
   * 按部類配額抽樣，不是均勻抽樣。
   *
   * ── 為什麼要改
   *
   * 第一版用等距抽樣，看起來「平均」，實際上照檔案數分佈：密教部
   * 拿 116 段、經集部 108 段，兩部就超過一半，而般若部只有 12 段。
   *
   * 結果首頁第一屏連續五段都是陀羅尼（T1070、T1376、T1175、T1303、
   * T1363），還有悉曇音譯「唵嚩日囉…」夾在裡面。對一個第一次來的
   * 人，那不是「這個站在讀經」，那是「這是什麼看不懂的東西」。
   *
   * ── 配額怎麼定
   *
   * 以「一般讀者會想讀到的」為主：阿含、般若、法華、華嚴、涅槃、
   * 淨土這些是佛教的核心經典。密教部（咒語多、需要灌頂）與史傳部
   * （傳記、目錄）壓到很低，但不歸零——它們也是藏經的一部分。
   *
   * 剩下的名額平均分給其他各部。
   */
  const QUOTA = {
    '01阿含部類': 52,
    '02本緣部類': 30,
    '03般若部類': 44,
    '04法華部類': 34,
    '05華嚴部類': 30,
    '06寶積部類': 26,
    '07涅槃部類': 22,
    '08大集部類': 16,
    '16淨土宗部類': 26,
    '17禪宗部類': 20,
    '10密教部類': 22,
    '18史傳部類': 12,
  };

  /** 制式開場：「一時，佛在…」。語料裡佔四成，讀起來高度重複。 */
  const OPENING_FORMULA = /^(一時|爾時|佛告|如是我聞|其時|於時)/;

  function canonOf(rel) {
    var parts = rel.split('/');
    return parts.length > 1 ? parts[1] : '';
  }

  // 按部類分組
  const byCanon = new Map();
  for (const item of picked) {
    const c = canonOf(item.p);
    if (!byCanon.has(c)) byCanon.set(c, []);
    byCanon.get(c).push(item);
  }

  /** 從一個部類裡等距取 n 段（保留多樣性，不取前面幾個）。 */
  function takeEven(arr, n) {
    if (n >= arr.length) return arr.slice();
    const out = [];
    const step = arr.length / n;
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  const sampled = [];
  const usedFiles = new Set();

  /**
   * 同一部經只取一段，避免整條流被少數幾部大經佔滿。
   *
   * 並且優先取「非制式開場」的段落。
   *
   * 走過的坑：制式開場（「一時，佛在…」）在語料裡佔 40%。原本照順序
   * 取，抽出來的段落有 168 段是開場，但 2:1 交錯只排得下 140 段，
   * 剩下的 42 段全部堆在尾巴——實測連續 43 段都是「爾時，世尊…」。
   *
   * 從源頭限流：挑選時先拿正文，不夠才用開場補。這樣開場自然落在
   * 三分之一以下，交錯才有意義。
   */
  function takeUnique(arr, n) {
    const body = arr.filter(x => !OPENING_FORMULA.test(x.x));
    const open = arr.filter(x => OPENING_FORMULA.test(x.x));

    const out = [];
    const seen = new Set();
    const push = (item) => {
      if (out.length >= n) return false;
      if (seen.has(item.p)) return true;
      seen.add(item.p);
      out.push(item);
      return out.length < n;
    };

    for (const item of body) { if (!push(item)) return out; }
    for (const item of open) { if (!push(item)) return out; }
    return out;
  }

  for (const [canon, n] of Object.entries(QUOTA)) {
    const pool = byCanon.get(canon) || [];
    if (!pool.length) continue;
    for (const item of takeUnique(takeEven(pool, n * 3), n)) {
      sampled.push(item);
      usedFiles.add(item.p);
    }
  }

  // 剩下的名額：從沒被配額列到的部類補，仍然一部經一段
  const leftovers = [];
  for (const [canon, pool] of byCanon) {
    if (QUOTA[canon]) continue;
    for (const item of pool) leftovers.push(item);
  }
  for (const item of takeUnique(takeEven(leftovers, (TARGET - sampled.length) * 3),
                                TARGET - sampled.length)) {
    sampled.push(item);
    usedFiles.add(item.p);
  }

  console.log('配額後段數:', sampled.length);

  /*
   * 排開「制式開場」。
   *
   * 經文的開頭高度格式化：「一時，佛在…」「爾時，世尊…」「佛告須菩提：」。
   * 實測 39.8% 的段落是這樣開始的，而第一屏連續三段都是「一時佛遊於…與
   * 大比丘眾俱」——讀起來像同一段重複三次。
   *
   * 做法：把段落分成「制式開場」與「其他」兩堆，交錯排列。這樣讀者往下
   * 捲，開場白與內容段落會輪流出現，節奏比較像在讀書，不像在看清單。
   */
  const formula = sampled.filter(x => OPENING_FORMULA.test(x.x));
  const rest = sampled.filter(x => !OPENING_FORMULA.test(x.x));

  /** 洗牌（Fisher-Yates）。 */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  shuffle(formula);
  shuffle(rest);

  /*
   * 交錯比例 1:2——每三段裡最多一段是制式開場。
   *
   * 不是 1:1，因為開場白本來就只是引子；全部輪流會讓「一時佛在」出現
   * 得太頻繁。
   */
  /*
   * 合併兩堆：嚴格按「2 段正文 + 1 段開場」的節奏，用索引直接算，
   * 不用「每次挑一個」的迴圈。
   *
   * 走過的坑：用 while + 條件挑選，看起來會交錯，實際上在外面那層
   * 「相鄰同經」重排之後，順序被打亂成 39 段連續開場。索引式合併
   * 沒有這個自由度，結果是確定的。
   */
  const merged = [];
  let fi = 0, ri = 0;
  while (ri < rest.length || fi < formula.length) {
    if (ri < rest.length) merged.push(rest[ri++]);
    if (ri < rest.length) merged.push(rest[ri++]);
    if (fi < formula.length) merged.push(formula[fi++]);
  }

  /*
   * 最後檢查「相鄰同經」。
   *
   * 不重排（重排會破壞上面的交錯節奏），只偵測：配額抽樣已經保證一部
   * 經只取一段，所以相鄰同經幾乎不可能發生。真的發生就交換那一段與
   * 下一段，局部處理，不動整體順序。
   */
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].p === merged[i - 1].p && i + 1 < merged.length) {
      const t = merged[i]; merged[i] = merged[i + 1]; merged[i + 1] = t;
    }
  }

  const sampledFinal = merged;

  const body = JSON.stringify(sampledFinal);
  const out = `/**
 * @file passages-data.js
 *
 * 自動產生，請勿手改。重新產生：
 *   node scripts/gen-passages.js
 *
 * 「經文流」：${sampled.length} 段可直接閱讀的經文，來自 ${
    new Set(sampled.map(s => s.p)).size
  } 個檔案。
 *
 * 每段的欄位：
 *   p  檔案路徑（相對 md/，不含 md/ 前綴）
 *   l  行號（給 window.mdwOpenFile(path, line) 用）
 *   id 經號
 *   t  經名
 *   x  內文
 */

(function (global) {
  'use strict';

  var list = ${body};

  global.PassagesData = {
    list: list,
    count: list.length,

    /*
     * 一律讀 this.list，不讀閉包裡的 list。
     *
     * 兩者原本是同一份參考，但外部一旦替換 PassagesData.list（測試會
     * 這麼做），閉包還握著舊資料——這種「改了沒生效」的分岔很難查。
     */
    after: function (idx, n) {
      var arr = this.list || [];
      var out = [];
      if (!arr.length) return out;
      for (var i = 1; i <= (n || 1); i++) {
        out.push(arr[(((idx + i) % arr.length) + arr.length) % arr.length]);
      }
      return out;
    },

    at: function (idx) {
      var arr = this.list || [];
      if (!arr.length) return null;
      return arr[((idx % arr.length) + arr.length) % arr.length];
    }
  };
})(typeof window !== 'undefined' ? window : this);
`;

  fs.writeFileSync(OUT, out, 'utf8');
  console.log('寫出:', OUT);
  console.log('段數:', sampledFinal.length, '| 檔案大小:', Math.round(out.length / 1024) + 'KB');
  console.log('涵蓋檔案:', new Set(sampledFinal.map(s => s.p)).size);
}

main();
