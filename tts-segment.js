/**
 * 朗讀（TTS）的標準斷句、章節後備與選取吸附（瀏覽器與伺服器共用，純函式，無 I/O）。
 *
 * 核心不變式：斷句只看「空行分隔的段落」本身（散文更只看一行），結果與使用者選了什麼、
 * 從哪裡開始讀、整篇預先生成或單句即時生成完全無關；同一段文字永遠切出相同的句子。
 * 判斷條件都是下面的常數，改動任何一個都會讓部分句子的快取失效，要連同
 * tests/test-tts-segment.test.js 一起改。
 *
 * 座標：`line` 是原檔的行號（1 起算）；`a`／`b` 是該行「正規化後文字」的位移
 * （UTF-16 code unit，和瀏覽器的字串位移一致）。跨行的偈頌單位另有 `endLine`，
 * 此時 `a` 屬於 `line`、`b` 屬於 `endLine`。
 *
 * 詳見 ARCHITECTURE.md「朗讀（TTS）」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MdwTtsSegment = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 規則版本：只供除錯與後台顯示，不進快取鍵（規則改了只有切法變動的句子重生）。 */
  const RULES_VERSION = '1';

  const DEFAULTS = {
    maxLen: 120,        // 句長硬上限（後台可調，40–200）
    minLen: 8,          // 不足此長度的片段併入同一行的鄰句
    fixedLen: 36,       // 完全沒有切點時的固定長度（四字格對齊）
    longLine: 400,      // 單行偈頌的長度上限；超過視為散文
    groupCap: 600,      // 納入整組偈頌／咒語的總長上限
    quoteCap: 200,      // 引號補全後的總長上限，超過就不補
    padMin: 15,         // 吸附後不足此長度就補句
    readNotes: false,   // 夾注（…）讀或不讀（全站設定）
    readNonScripture: false, // 「版權說明」「目錄」等區段讀或不讀（全站設定）
    lexicon: []         // [[詞, 替換]]；替換為空字串＝只保護不切開
  };

  const STRONG = new Set('。！？；');
  const CLOSERS = new Set('」』）》〕】)”’');
  const PAIRS = { '「': '」', '『': '』', '《': '》', '（': '）', '〔': '〕', '【': '】', '(': ')', '“': '”', '‘': '’' };
  const CLOSE2OPEN = {};
  Object.keys(PAIRS).forEach((o) => { CLOSE2OPEN[PAIRS[o]] = o; });
  const INTRO = /(佛告[^：:，。]{0,12}|[^：:，。]{0,12}白佛言|[^：:，。]{0,8}(?:言|曰|云|說偈言|說咒曰|說呪曰))[：:]$/;
  const STARTERS = ['爾時', '是時', '復次', '佛告'];
  const CHAPTER_STARTER = /^(爾時|是時|復次|佛告|[^，。]{0,10}白佛言)/;
  const PARTICLES = new Set('也者矣焉哉');
  const NUM = '〇一二三四五六七八九十百千廿卅0-9０-９';
  const SKIP = new RegExp('^(?:[' + NUM + '（）()．.、△○●◎※＊*·・\\-—–_=~\\s]+|\\[TOC\\]|Tape\\s*\\d+.*|PAGE\\s*\\d+|[\\w.+-]+@[\\w.-]+|[0-9()\\-\\s]{7,}|No\\.\\s*\\d+.*|[^\\u3400-\\u9fff\\uf900-\\ufaffA-Za-z0-9]+)$', 'i');
  // 文字行標題：整段只有這一行、≤ 30 字、沒有句讀。STRICT 命中才當章節起點。
  const TEXT_HEADING = new RegExp('^(?:.{0,24}(?:品|分|章|會|門)第[' + NUM + ']+.{0,6}|.{0,24}卷(?:第[' + NUM + ']+|[上中下])(?:.{0,6})|.{0,20}序品(?:第[' + NUM + ']+)?|[' + NUM + ']{1,3}[ ]+[^，。；：]{2,20})$');
  const TEXT_HEADING_STRICT = new RegExp('(?:品|分|章|會|門)第[' + NUM + ']+|卷(?:第[' + NUM + ']+|[上中下])|序品');
  const HEADING_CLOSER = /終[)）〕】]?$/;
  const MANTRA_CH = new Set('囉嚩怛唵吽曩謨嚕跢哩嚟抳拏誐馱駄惹捺弭鑁喃娜麼㘑嚧吒呬醯谿嘚哆隸鉢');
  const NONSCRIPTURE_HEAD = /^(?:版權|著作權|目錄|目次|編輯說明|凡例|校勘|參考書目|索引)/;
  const CJK_RE = /[㐀-鿿豈-﫿]/;

  // 整行只有連結與分隔符號（「前一篇 · 目錄 · 後一篇」這種導覽列）：不朗讀
  const NAV_LINE = /^(?:\s*(?:\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\))\s*[·•|｜／\/\-—]*\s*)+$/;

  const TOK_SRC ='!\\[[^\\]]*\\]\\([^)]*\\)|\\[\\[(?:[^\\]|]*\\|)?([^\\]]*)\\]\\]|\\[([^\\]]+)\\]\\([^)]*\\)|\\[\\^[^\\]]+\\]|\\[[0-9A-Za-z＊*]{1,8}\\]|<[^>]+>|\\*\\*|__|~~|`|\\*';
  const LEAD = /^\s*(?:#{1,6}\s+|(?:>\s?)+|[-+]\s+)/;

  /**
   * 正規化一行原文：去掉 Markdown 記號、註腳標號、HTML 標籤、圖片；連結只留顯示字；
   * 連續空白（含全形空格）收成一個。回傳 { t, map }，map[i] 是清理後第 i 個字在原行的位移。
   */
  function normalizeLine(raw, isTable) {
    const keep = [];
    let pos = 0;
    const lead = LEAD.exec(raw);
    if (lead) pos = lead[0].length;
    const tok = new RegExp(TOK_SRC, 'g');
    tok.lastIndex = pos;
    let m;
    while ((m = tok.exec(raw))) {
      if (m.index > pos) keep.push([pos, m.index]);
      const inner = m[1] !== undefined ? m[1] : m[2];
      if (inner !== undefined && inner !== '') {
        const s = m.index + m[0].indexOf(inner, m[1] !== undefined ? 2 : 1);
        keep.push([s, s + inner.length]);
      }
      pos = m.index + m[0].length;
      if (m[0].length === 0) tok.lastIndex++;
    }
    if (pos < raw.length) keep.push([pos, raw.length]);
    let t = ''; const map = [];
    for (let x = 0; x < keep.length; x++) {
      for (let i = keep[x][0]; i < keep[x][1]; i++) {
        let c = raw[i];
        if (c === '\r') continue;
        if (isTable && c === '|') c = ' ';
        if (c === ' ' || c === '　' || c === '\t' || c === ' ') {
          if (t.length && t[t.length - 1] !== ' ') { t += ' '; map.push(i); }
          continue;
        }
        t += c; map.push(i);
      }
    }
    if (t.endsWith(' ')) { t = t.slice(0, -1); map.pop(); }
    return { t, map };
  }

  /** 一行是否為整齊的偈頌行：{ n: 小句數, len: 每句字數, ws: 以空白分隔 } 或 null。 */
  function verseInfo(t) {
    const cl = t.replace(/[「」『』]/g, '').split(/[，。；、！？：:\s]+/).filter(Boolean);
    if (!cl.length) return null;
    const L = Array.from(cl[0]).length;
    if (L !== 4 && L !== 5 && L !== 7) return null;
    for (let i = 0; i < cl.length; i++) if (Array.from(cl[i]).length !== L) return null;
    return { n: cl.length, len: L, ws: /[㐀-鿿] [㐀-鿿]/.test(t) };
  }

  /** 咒語行：音譯專用字佔漢字 ≥ 22%，或有 ≥ 3 個「二合／引」標記且密度 ≥ 10%。 */
  function mantraLike(t) {
    let total = 0, n = 0;
    for (const c of t) { if (CJK_RE.test(c)) { total++; if (MANTRA_CH.has(c)) n++; } }
    if (total < 12) return false;
    const marks = (t.match(/二合|引[）)]/g) || []).length;
    const d = n / total;
    return d >= 0.22 || (marks >= 3 && d >= 0.1);
  }

  // depth[k] = 包住切點 k 的「同一行內真正成對」的括號層數。未配對的開、關引號忽略：
  // CBETA 的跨段引文每段開頭都有「而不收，若算進去整段都切不開。
  function matchedDepth(t) {
    const d = new Int16Array(t.length + 1); const stack = []; const spans = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (PAIRS[c]) stack.push([c, i]);
      else if (CLOSE2OPEN[c]) {
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j][0] === CLOSE2OPEN[c]) { spans.push([stack[j][1], i]); stack.length = j; break; }
        }
      }
    }
    for (let s = 0; s < spans.length; s++) for (let k = spans[s][0] + 1; k <= spans[s][1]; k++) d[k]++;
    return d;
  }

  // 不得切開：讀音字典的詞、連續英數字、短夾注內部、UTF-16 代理對。
  function protectedMask(t, lexicon) {
    const p = new Uint8Array(t.length + 1);
    for (let x = 0; x < lexicon.length; x++) {
      const w = lexicon[x][0]; let i = -1;
      while ((i = t.indexOf(w, i + 1)) >= 0) for (let k = i + 1; k < i + w.length; k++) p[k] = 1;
    }
    const pr = /[（(][^（()）]{0,12}[)）]/g; let pm;
    while ((pm = pr.exec(t))) for (let k = pm.index + 1; k < pm.index + pm[0].length; k++) p[k] = 1;
    for (let k = 1; k < t.length; k++) {
      const a = t.charCodeAt(k - 1), b = t.charCodeAt(k);
      const an = (a >= 48 && a <= 57) || (a >= 65 && a <= 90) || (a >= 97 && a <= 122);
      const bn = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
      if (an && bn) p[k] = 1;
      if (b >= 0xdc00 && b <= 0xdfff) p[k] = 1;
    }
    return p;
  }

  /** 切點與強度：5 句讀、4 問答引導冒號後、3 引號內句讀與發端詞前、2 逗頓與空白、1 句尾助詞後。 */
  function cutPoints(t, prot) {
    const d = matchedDepth(t); const pts = new Map();
    const put = (k, s) => { if (k > 0 && k < t.length && !prot[k] && (pts.get(k) || 0) < s) pts.set(k, s); };
    for (let i = 0; i < t.length; i++) {
      const c = t[i]; let k = i + 1;
      while (k < t.length && CLOSERS.has(t[k])) k++;
      if (STRONG.has(c)) put(k, d[k] === 0 ? 5 : 3);
      else if ((c === '：' || c === ':') && d[i] === 0 && INTRO.test(t.slice(Math.max(0, i - 16), i + 1))) put(k, 4);
      else if ((c === '，' || c === '、' || c === ' ') && d[k] === 0) put(k, 2);
      else if (PARTICLES.has(c) && k < t.length && '，。、；：'.indexOf(t[k]) < 0 && d[k] === 0) put(k, 1);
    }
    for (let s = 0; s < STARTERS.length; s++) {
      let i = 0;
      while ((i = t.indexOf(STARTERS[s], i + 1)) > 0) if (d[i] === 0) put(i, 3);
    }
    return pts;
  }

  function splitLong(t, a, b, pts, prot, out, st, o) {
    if (b - a <= o.maxLen) { out.push([a, b]); return; }
    const mid = (a + b) / 2; let best = -1;
    for (let s = 5; s >= 1 && best < 0; s--) {
      let bd = Infinity;
      pts.forEach((v, k) => {
        if (v === s && k >= a + o.minLen && k <= b - o.minLen && Math.abs(k - mid) < bd) { bd = Math.abs(k - mid); best = k; }
      });
    }
    if (best < 0) { // 最後手段：固定長度
      st.hardCuts++;
      best = a + (/[，。、；：！？ ]/.test(t.slice(a, b)) ? o.maxLen : Math.min(o.fixedLen, o.maxLen));
      while (best > a + 1 && prot[best]) best--;
    }
    splitLong(t, a, best, pts, prot, out, st, o); splitLong(t, best, b, pts, prot, out, st, o);
  }

  /** 一行散文的標準句：[{ a, b, kind: 'sent' | 'intro' }] */
  function segmentProse(t, o, st) {
    const prot = protectedMask(t, o.lexicon);
    const pts = cutPoints(t, prot);
    const strong = [];
    pts.forEach((s, k) => { if (s >= 4) strong.push(k); });
    strong.sort((x, y) => x - y); strong.push(t.length);
    const pieces = []; let a = 0;
    for (let x = 0; x < strong.length; x++) if (strong[x] > a) { splitLong(t, a, strong[x], pts, prot, pieces, st, o); a = strong[x]; }
    const merged = [];
    for (let x = 0; x < pieces.length; x++) {
      const last = merged[merged.length - 1];
      if (last && last[1] - last[0] < o.minLen && pieces[x][1] - last[0] <= o.maxLen) last[1] = pieces[x][1];
      else merged.push([pieces[x][0], pieces[x][1]]);
    }
    if (merged.length > 1) {
      const l = merged[merged.length - 1], p = merged[merged.length - 2];
      if (l[1] - l[0] < o.minLen && l[1] - p[0] <= o.maxLen) { p[1] = l[1]; merged.pop(); }
    }
    return merged.map((r) => ({ a: r[0], b: r[1], kind: /[：:]$/.test(t.slice(r[0], r[1]).trim()) ? 'intro' : 'sent' }));
  }

  /** 偈頌：四小句（一偈）一個單位。 */
  function segmentVerse(t, o) {
    const ends = []; const re = /[，。；、！？：: ]+[」』]*/g; let m;
    while ((m = re.exec(t))) ends.push(m.index + m[0].length);
    if (!ends.length || ends[ends.length - 1] !== t.length) ends.push(t.length);
    const units = []; let a = 0;
    for (let x = 0; x < ends.length; x++) {
      if ((x + 1) % 4 === 0 || ends[x] === t.length) { if (ends[x] > a) units.push({ a, b: ends[x], kind: 'verse' }); a = ends[x]; }
    }
    if (units.length > 1) {
      const l = units[units.length - 1], p = units[units.length - 2];
      if (l.b - l.a < o.minLen) { p.b = l.b; units.pop(); }
    }
    return units;
  }

  /** 口語化：斷句之後、雜湊之前套用。會改變文字的選項都必須是全站設定。 */
  function oralize(text, kind, o) {
    let s = text;
    if (kind === 'mantra') s = s.replace(/（[^（）]*）|\([^()]*\)/g, ''); // 「（引）」「（二合）」等注音標記一律不讀
    else if (!o.readNotes) s = s.replace(/（[^（）]*）|\([^()]*\)/g, '');
    s = kind === 'verse'
      ? s.replace(/([㐀-鿿]) (?=[㐀-鿿])/g, '$1，')
      : s.replace(/([㐀-鿿」』]) (?=[㐀-鿿「『])/g, '$1');
    for (let x = 0; x < o.lexicon.length; x++) {
      const w = o.lexicon[x][0], r = o.lexicon[x][1];
      if (r && s.indexOf(w) >= 0) s = s.split(w).join(r);
    }
    return s.trim();
  }

  function withDefaults(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    o.maxLen = Math.max(40, Math.min(200, Math.floor(Number(o.maxLen)) || DEFAULTS.maxLen));
    o.lexicon = (Array.isArray(o.lexicon) ? o.lexicon : []).filter((e) => e && e[0])
      .map((e) => [String(e[0]), String(e[1] || '')]).sort((x, y) => y[0].length - x[0].length);
    return o;
  }

  /**
   * 整篇斷句。回傳 { units, stats }。
   * unit：{ i, block, line, endLine, a, b, kind, text, spoken?, group?, level?, strict? }
   *   kind：'sent' | 'intro' | 'verse' | 'mantra' | 'heading' | 'skip'（skip 不朗讀、沒有 spoken）
   */
  function segmentDoc(doc, opts) {
    const o = withDefaults(opts);
    const st = { hardCuts: 0, lines: 0, softWrap: 0, verseLines: 0, mantraLines: 0, voiced: 0, chars: 0 };
    const units = [];
    const lines = String(doc).split('\n');
    let i = 0; let inFence = false; let nonScriptureLevel = 0; let bi = -1; let group = 0;
    if (lines.length && lines[0].trim() === '---') { // YAML front matter
      let j = 1; while (j < lines.length && lines[j].trim() !== '---') j++;
      if (j < lines.length) i = j + 1;
    }
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      let j = i; while (j < lines.length && lines[j].trim()) j++;
      bi++;
      const L = [];
      for (let k = i; k < j; k++) {
        const raw = lines[k]; const tr = raw.trim();
        if (/^(```|~~~)/.test(tr)) { inFence = !inFence; continue; }
        if (inFence || tr.indexOf('//') === 0) continue;
        const isTable = tr[0] === '|';
        if (isTable && /^\|?[\s:|-]+\|?$/.test(tr)) continue;
        const nl = /^\[toc\]$/i.test(tr) ? { t: tr } : normalizeLine(raw, isTable);
        if (!nl.t) continue;
        const rec = { k, t: nl.t, kind: 'prose' };
        const h = /^\s*(#{1,6})\s+/.exec(raw);
        if (h) { rec.kind = 'heading'; rec.level = h[1].length; } // 「# 一」這種純編號標題仍是標題
        else if (/^\[toc\]$/i.test(tr) || SKIP.test(nl.t) || NAV_LINE.test(tr)) rec.kind = 'skip';
        else { rec.verse = verseInfo(nl.t); if (mantraLike(nl.t)) rec.kind = 'mantra'; }
        L.push(rec);
      }
      if (L.length === 1 && L[0].kind === 'prose' && Array.from(L[0].t).length <= 30 && !/[，。；？！]/.test(L[0].t) && TEXT_HEADING.test(L[0].t)) {
        L[0].kind = 'heading'; L[0].level = 0; L[0].strict = TEXT_HEADING_STRICT.test(L[0].t);
      }
      // 偈頌：同段內連續、每小句等長的整齊行
      for (let x = 0; x < L.length;) {
        if (L[x].kind !== 'prose' || !L[x].verse) { x++; continue; }
        let y = x, n = 0; const len = L[x].verse.len;
        while (y < L.length && L[y].kind === 'prose' && L[y].verse && L[y].verse.len === len) { n += L[y].verse.n; y++; }
        const ok = y - x === 1 ? (L[x].verse.ws ? n >= 2 : n >= 4) && L[x].t.length <= o.longLine : n >= 4;
        if (ok) { group++; for (let z = x; z < y; z++) { L[z].kind = 'verse'; L[z].group = group; } }
        x = y;
      }
      // 偈頌的連續行接成一條虛擬行，讓一偈可以跨行；segs 記每一實體行在虛擬行中的起點
      const R = [];
      for (let x = 0; x < L.length; x++) {
        const r = L[x]; const prev = R[R.length - 1];
        if (r.kind === 'verse' && prev && prev.kind === 'verse' && prev.group === r.group) {
          prev.segs.push({ k: r.k, start: prev.t.length + 1 }); prev.t += ' ' + r.t;
        } else R.push({ kind: r.kind, t: r.t, level: r.level, strict: r.strict, group: r.group, segs: [{ k: r.k, start: 0 }] });
      }
      for (let x = 0; x < R.length; x++) {
        const r = R[x]; st.lines += r.segs.length;
        let us;
        if (r.kind === 'heading') {
          if (r.level > 0) {
            if (NONSCRIPTURE_HEAD.test(r.t)) nonScriptureLevel = r.level;
            else if (nonScriptureLevel && r.level <= nonScriptureLevel) nonScriptureLevel = 0;
          }
          us = [{ a: 0, b: r.t.length, kind: (nonScriptureLevel && !o.readNonScripture) ? 'skip' : 'heading', level: r.level, strict: r.strict }];
        } else if (r.kind === 'skip' || (nonScriptureLevel && !o.readNonScripture)) us = [{ a: 0, b: r.t.length, kind: 'skip' }];
        else if (r.kind === 'verse') {
          st.verseLines += r.segs.length;
          us = segmentVerse(r.t, o); for (let u = 0; u < us.length; u++) us[u].group = 'v' + r.group;
        } else {
          us = segmentProse(r.t, o, st);
          if (r.kind === 'mantra') { st.mantraLines++; group++; for (let u = 0; u < us.length; u++) { us[u].kind = 'mantra'; us[u].group = 'm' + group; } }
          else if (x < R.length - 1 && !/[。！？；：」』）]$/.test(r.t)) st.softWrap++;
        }
        for (let u = 0; u < us.length; u++) {
          let a = us[u].a, b = us[u].b;
          while (a < b && r.t[a] === ' ') a++;
          while (b > a && r.t[b - 1] === ' ') b--;
          if (b <= a) continue;
          let sa = 0, sb = 0;
          for (let s = 0; s < r.segs.length; s++) { if (r.segs[s].start <= a) sa = s; if (r.segs[s].start < b) sb = s; }
          const text = r.t.slice(a, b);
          const unit = { i: units.length, block: bi, line: r.segs[sa].k + 1, endLine: r.segs[sb].k + 1,
            a: a - r.segs[sa].start, b: b - r.segs[sb].start, kind: us[u].kind, text };
          if (us[u].group) unit.group = us[u].group;
          if (us[u].level !== undefined) { unit.level = us[u].level; if (us[u].strict) unit.strict = true; }
          if (unit.kind !== 'skip') {
            unit.spoken = oralize(text, unit.kind, o);
            if (!unit.spoken || !/[㐀-鿿豈-﫿A-Za-z0-9]/.test(unit.spoken)) { unit.kind = 'skip'; delete unit.spoken; }
            else { st.voiced++; st.chars += unit.spoken.length; }
          }
          units.push(unit);
        }
      }
      i = j;
    }
    st.guessed = st.voiced > 0 && st.hardCuts / st.voiced > 0.01; // 後台標示「斷句為自動推測」
    return { units, stats: st };
  }

  /**
   * 章節四層後備。回傳 { layer, chapters: [{ i, title, line, from, to, chars, layer }] }，
   * from／to 是 units 的索引（to 不含）。layer：1 `#` 標題、2 卷品文字行、3 語義邊界、4 固定字數。
   */
  function detectChapters(units) {
    const voiced = (u) => u.kind !== 'skip';
    const len = (a, b) => { let n = 0; for (let k = a; k < b; k++) if (voiced(units[k])) n += units[k].text.length; return n; };
    const md = [], txt = []; const seen = new Set();
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.kind !== 'heading') continue;
      if (u.level > 0) md.push(k);
      else if (u.strict) { // 同一標題再次出現、或以「終」結尾：卷尾標記，照讀但不開新章
        if (!seen.has(u.text) && !HEADING_CLOSER.test(u.text)) txt.push(k);
        seen.add(u.text);
      }
    }
    let layer; let starts = [];
    if (md.length >= 4) { layer = 1; starts = md.concat(txt).sort((a, b) => a - b); }
    else if (txt.length >= 1) { layer = 2; starts = md.concat(txt).sort((a, b) => a - b); }
    else layer = 3;
    const semantic = (a, b, target) => {
      const out = [a]; let acc = 0;
      for (let k = a; k < b; k++) {
        const u = units[k]; const first = k === a || units[k - 1].block !== u.block;
        if (first && acc >= target && voiced(u) && CHAPTER_STARTER.test(u.text)) { out.push(k); acc = 0; }
        if (voiced(u)) acc += u.text.length;
      }
      return out.length > 1 ? out : null;
    };
    const fixed = (a, b, target) => {
      const out = [a]; let acc = 0;
      for (let k = a; k < b; k++) {
        if (k > a && ((units[k - 1].block !== units[k].block && acc >= target) || acc >= 4000)) { out.push(k); acc = 0; }
        if (voiced(units[k])) acc += units[k].text.length;
      }
      return out;
    };
    const mk = (a, b, lay, title) => ({ from: a, to: b, chars: len(a, b), layer: lay, title });
    let first = [];
    if (starts.length) {
      const lead = starts[0] > 0 && len(0, starts[0]) > 0; // 第一個標題之前有可讀的內容才自成一章，否則併入第一章
      if (lead) first.push(mk(0, starts[0], layer, ''));
      for (let x = 0; x < starts.length; x++) {
        first.push(mk(x === 0 && !lead ? 0 : starts[x], x + 1 < starts.length ? starts[x + 1] : units.length, layer, units[starts[x]].text));
      }
    } else if (units.length) {
      const sem = semantic(0, units.length, 1500);
      const cut = sem || fixed(0, units.length, 2500);
      if (!sem) layer = 4;
      for (let x = 0; x < cut.length; x++) first.push(mk(cut[x], x + 1 < cut.length ? cut[x + 1] : units.length, layer, ''));
    }
    // 任一章超過 5000 字就在章內用下一層再細切
    const out = [];
    for (let x = 0; x < first.length; x++) {
      const c = first[x];
      if (c.chars <= 5000) { out.push(c); continue; }
      let sub = c.layer < 3 ? semantic(c.from, c.to, 1500) : null; let lay = 3;
      if (!sub) { sub = fixed(c.from, c.to, 2500); lay = 4; }
      for (let y = 0; y < sub.length; y++) {
        const p = mk(sub[y], y + 1 < sub.length ? sub[y + 1] : c.to, lay, c.title); p.part = y + 1;
        if (p.chars > 5000 && lay === 3) {
          const f = fixed(p.from, p.to, 2500);
          for (let z = 0; z < f.length; z++) { const q = mk(f[z], z + 1 < f.length ? f[z + 1] : p.to, 4, c.title); q.part = (y + 1) + '-' + (z + 1); out.push(q); }
        } else out.push(p);
      }
    }
    for (let x = 0; x < out.length; x++) { out[x].i = x; out[x].line = units[out[x].from] ? units[out[x].from].line : 1; }
    return { layer, chapters: out };
  }

  /** (line, off) 是否落在 unit 之前（-1）、之內（0）、之後（1）。 */
  function comparePos(u, line, off) {
    if (line < u.line || (line === u.line && off < u.a)) return -1;
    if (line > u.endLine || (line === u.endLine && off >= u.b)) return 1;
    return 0;
  }

  /**
   * 選取吸附：把 [start, end) 吸附到完整的標準句與語義組。
   * start／end：{ line, off }（off 為該行正規化後文字的位移；end 不含）。
   * 回傳 { from, to, selFrom, selTo, flags } 或 null（選取內沒有任何單位）；from／to 為含頭含尾的 units 索引。
   * flags：extended、group、intro、quote、padded、incomplete（補全單位過長而放棄）。
   */
  function snapSelection(units, start, end, opts) {
    const o = withDefaults(opts);
    let i0 = -1, i1 = -1;
    let lo = 0, hi = units.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (comparePos(units[mid], start.line, start.off) > 0) lo = mid + 1; else hi = mid; }
    for (let k = lo; k < units.length; k++) {
      const u = units[k];
      if (u.line > end.line || (u.line === end.line && u.a >= end.off)) break;
      if (comparePos(u, start.line, start.off) > 0) continue;
      if (i0 < 0) i0 = k; i1 = k;
    }
    if (i0 < 0) return null;
    const s0 = i0, s1 = i1; const flags = {};
    const total = () => { let n = 0; for (let k = i0; k <= i1; k++) if (units[k].kind !== 'skip') n += units[k].text.length; return n; };
    const nxt = (k) => { k++; while (k < units.length && units[k].kind === 'skip') k++; return k < units.length && units[k].kind !== 'heading' ? k : -1; };
    const prv = (k) => { k--; while (k >= 0 && units[k].kind === 'skip') k--; return k >= 0 && units[k].kind !== 'heading' ? k : -1; };
    const grow = (k, dir) => { const g = units[k].group; let x = k; if (g) while (units[x + dir] && units[x + dir].group === g) x += dir; return x; };
    const glen = (a, b) => { let n = 0; for (let k = a; k <= b; k++) n += units[k].text.length; return n; };
    // 整組偈頌／咒語（組長在上限內）
    [i0, i1].forEach((k) => {
      if (!units[k].group) return;
      const a = grow(k, -1), b = grow(k, 1);
      if (glen(a, b) <= o.groupCap) { if (a < i0) { i0 = a; flags.group = true; } if (b > i1) { i1 = b; flags.group = true; } }
      else flags.incomplete = true;
    });
    // 引導句需要後文（可跨段落）；緊接在引導句後的引文把引導句納入
    let j = nxt(i1);
    if (units[i1].kind === 'intro' && j >= 0) {
      i1 = units[j].group && glen(grow(j, -1), grow(j, 1)) <= o.groupCap ? grow(j, 1) : j; flags.intro = true;
    }
    j = prv(i0);
    if (j >= 0 && units[j].kind === 'intro') { i0 = j; flags.intro = true; }
    // 引號平衡：只在同一段落內判斷（跨段引文慣例）
    const blkBal = (a, b, blk) => {
      let n = 0;
      for (let k = a; k <= b; k++) if (units[k].block === blk) for (const c of units[k].text) { if (c === '「' || c === '『') n++; else if (c === '」' || c === '』') n--; }
      return n;
    };
    const bal = (a, b) => { const e = blkBal(a, b, units[b].block); return e > 0 ? e : Math.min(0, blkBal(a, b, units[a].block)); };
    const q0 = i0, q1 = i1; let grew = false;
    while (bal(i0, i1) > 0 && total() <= o.quoteCap && units[i1 + 1] && units[i1 + 1].block === units[i1].block && units[i1 + 1].kind !== 'heading') { i1++; grew = true; }
    while (bal(i0, i1) < 0 && total() <= o.quoteCap && i0 > 0 && units[i0 - 1].block === units[i0].block && units[i0 - 1].kind !== 'heading') { i0--; grew = true; }
    if (grew) { if (total() > o.quoteCap) { i0 = q0; i1 = q1; flags.incomplete = true; } else flags.quote = true; }
    while (total() < o.padMin) {
      if ((j = nxt(i1)) >= 0) { i1 = j; flags.padded = true; }
      else if ((j = prv(i0)) >= 0) { i0 = j; flags.padded = true; }
      else break;
    }
    if (i0 < s0 || i1 > s1) flags.extended = true;
    return { from: i0, to: i1, selFrom: s0, selTo: s1, flags };
  }

  /** 解析讀音字典文字（一行一條「詞｜替換」，# 開頭為註解；只有詞＝只保護不切開）。 */
  function parseLexicon(text) {
    const out = []; const seen = new Set();
    String(text || '').split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s[0] === '#') return;
      const parts = s.split(/[｜|]/);
      const w = (parts[0] || '').trim(); const r = (parts[1] || '').trim();
      if (!w || w.length > 40 || r.length > 80 || seen.has(w)) return;
      seen.add(w); out.push([w, r]);
    });
    return out;
  }

  return { RULES_VERSION, DEFAULTS, normalizeLine, segmentDoc, detectChapters, snapSelection, oralize, parseLexicon, verseInfo, mantraLike };
});
