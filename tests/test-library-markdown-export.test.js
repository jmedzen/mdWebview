/**
 * 書籤與劃線 Markdown 匯出（highlights.js 的 plainTextOfMarkdown／buildExcerpts／
 * buildLibraryMarkdown），以及個人偏好「備份與還原」區塊的按鈕接線（靜態檢查）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = require('../highlights.js');

const MD = [
  '---',
  'title: 金剛經',
  '---',
  '# 金剛般若波羅蜜經',
  '',
  '## 法會因由分第一',
  '',
  '如是我聞：一時，佛在舍衛國祇樹給孤獨園，與大比丘眾千二百五十人俱。爾時，世尊食時，著衣持缽，入舍衛大城乞食。於其城中，次第乞已，還至本處。飯食訖，收衣缽，洗足已，敷座而坐。',
  '',
  '## 善現啟請分第二',
  '',
  '時，長老**須菩提**在大眾中，即從座起，偏袒右肩，右膝著地，合掌恭敬而白佛言：「希有！世尊！如來善護念諸菩薩，善付囑諸菩薩。世尊！善男子、善女人，發阿耨多羅三藐三菩提心，應云何住？云何降伏其心？」佛言：「善哉，善哉。須菩提！如汝所說，如來善護念諸菩薩，善付囑諸菩薩。汝今諦聽！當為汝說：善男子、善女人，發阿耨多羅三藐三菩提心，應如是住，如是降伏其心。」「唯然，世尊！願樂欲聞。」',
  ''
].join('\n');
const FP = '經/T0235 金剛經.md';
const doc = H.plainTextOfMarkdown(MD);

function hl(q, c, nth) {
  let s = -1;
  for (let i = 0; i <= (nth || 0); i++) s = doc.text.indexOf(q, s + 1);
  assert.ok(s >= 0, `測試字串不在內文：${q}`);
  return Object.assign(H.makeAnchor(doc.text, s, s + q.length, doc.lineStarts), { c: c || 'r', filePath: FP });
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

describe('plainTextOfMarkdown', () => {
  test('去掉 frontmatter 與標記，行號照原檔', () => {
    assert.ok(!doc.text.includes('title'));
    assert.ok(!doc.text.includes('**'));
    assert.ok(doc.text.includes('長老須菩提在大眾中'));
    assert.deepEqual(doc.lineStarts[0], { line: 4, pos: 0 });
    assert.equal(doc.headings.map(h => h.text).join('|'), '金剛般若波羅蜜經|法會因由分第一|善現啟請分第二');
  });

  test('空行與標題是段落邊界；同段的多行接在一起', () => {
    const d = H.plainTextOfMarkdown('甲乙丙\n丁戊己\n\nabc\ndef\n');
    assert.equal(d.blocks.length, 2);
    assert.equal(d.text, '甲乙丙丁戊己abc def');
  });

  test('程式碼區塊不算內文', () => {
    const d = H.plainTextOfMarkdown('前\n```\ncode\n```\n後');
    assert.equal(d.text, '前後');
    assert.equal(d.blocks.length, 2);
  });

  test('連結、wiki 連結、圖片只留看得到的字', () => {
    assert.equal(H.plainLine('- 見[心經](a.md)與[[金剛經|金剛]]![圖](x.png)==重點=='), '見心經與金剛重點');
  });
});

describe('buildExcerpts', () => {
  test('同一段內靠近的劃線只出一段上下文', () => {
    const items = [hl('一時，佛在舍衛國'), hl('入舍衛大城乞食', 'y'), hl('洗足已', 'g')];
    const { excerpts, lost } = H.buildExcerpts(doc, items);
    assert.equal(lost.length, 0);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].count, 3);
    assert.equal(excerpts[0].marks.length, 3);
    assert.deepEqual(excerpts[0].colors, ['r', 'y', 'g']);
    assert.equal(excerpts[0].heading, '法會因由分第一');
    assert.equal(excerpts[0].line, 8);
  });

  test('不同段落各自一段，不跨段取上下文', () => {
    const { excerpts } = H.buildExcerpts(doc, [hl('洗足已'), hl('須菩提')]);
    assert.equal(excerpts.length, 2);
    assert.ok(!excerpts[0].text.includes('長老'));
    assert.ok(!excerpts[1].text.includes('敷座而坐'));
  });

  test('同段但相距很遠的劃線分開，上下文不重複', () => {
    const items = [hl('即從座起'), hl('唯然，世尊！願樂欲聞')];
    const { excerpts } = H.buildExcerpts(doc, items, { context: 10, slack: 5, mergeGap: 20 });
    assert.equal(excerpts.length, 2);
    assert.ok(excerpts[0].cut[1], '第一段後面被截斷');
    assert.ok(excerpts[1].cut[0], '第二段前面被截斷');
    const a = excerpts[0].text, b = excerpts[1].text;
    const posA = doc.text.indexOf(a), posB = doc.text.indexOf(b);
    assert.ok(posA + a.length <= posB, '兩段上下文不重疊');
  });

  test('上下文收在句讀', () => {
    const { excerpts } = H.buildExcerpts(doc, [hl('應云何住')], { context: 8, slack: 20, mergeGap: 16 });
    const t = excerpts[0].text;
    assert.ok(/^[^，。！？；：]/.test(t));
    assert.ok(/[，。！？；：、」]$/.test(t), t);
  });

  test('重疊的劃線合成一個標記', () => {
    const { excerpts } = H.buildExcerpts(doc, [hl('長老須菩提'), hl('須菩提在大眾中')]);
    assert.equal(excerpts[0].marks.length, 1);
    const [s, e] = excerpts[0].marks[0];
    assert.equal(excerpts[0].text.slice(s, e), '長老須菩提在大眾中');
  });

  test('找不到原處或沒有原文：列為 lost', () => {
    const gone = { filePath: FP, line: 3, off: 0, q: '完全不存在的句子', pre: '前', suf: '後', c: 'b' };
    assert.equal(H.buildExcerpts(doc, [gone]).lost.length, 1);
    assert.equal(H.buildExcerpts(null, [hl('洗足已')]).lost.length, 1);
  });

  test('原文小改後仍找得到', () => {
    const h = hl('入舍衛大城乞食');
    const d2 = H.plainTextOfMarkdown(MD.replace('著衣持缽', '著衣持鉢，'));
    const { excerpts, lost } = H.buildExcerpts(d2, [h]);
    assert.equal(lost.length, 0);
    const [s, e] = excerpts[0].marks[0];
    assert.equal(excerpts[0].text.slice(s, e), '入舍衛大城乞食');
  });
});

describe('buildLibraryMarkdown', () => {
  const highlights = [hl('一時，佛在舍衛國'), hl('入舍衛大城乞食', 'y'), hl('須菩提', 'g')];
  const bookmarks = [
    { filePath: FP, fileName: '金剛經', pct: 42.4 },
    { filePath: '經/心經.md', fileName: '心經' }
  ];
  const md = H.buildLibraryMarkdown({
    bookmarks, highlights, docs: new Map([[FP, doc]]),
    baseUrl: 'https://reader.example/', dateText: '2026/11/2',
    colorNames: { r: '朱', y: '黃', g: '綠', b: '藍' }
  });

  test('依書籤分節，標出劃線與行號連結', () => {
    assert.match(md, /^# 我的書籤與劃線/);
    assert.match(md, /書籤 2 個・劃線 3 處/);
    assert.match(md, /## 金剛經\n/);
    assert.match(md, /讀到 42%/);
    assert.match(md, /==一時，佛在舍衛國==/);
    assert.match(md, /==入舍衛大城乞食==/);
    assert.match(md, /\[第 8 行\]\(<https:\/\/reader\.example\/\?file=經\/T0235%20金剛經\.md&line=8>\)・朱、黃/);
    assert.match(md, /### 法會因由分第一/);
  });

  test('靠近的劃線，上下文只出現一次', () => {
    assert.equal(count(md, '如是我聞'), 1);
    assert.equal(count(md, '敷座而坐'), 1);
  });

  test('沒有劃線的書籤列在「其他書籤」', () => {
    assert.match(md, /## 其他書籤\n\n- \[心經\]\(<https:\/\/reader\.example\/\?file=經\/心經\.md>\)/);
  });

  test('拿不到原文時用劃線當時的前後文', () => {
    const out = H.buildLibraryMarkdown({ bookmarks, highlights: [highlights[2]], docs: new Map() });
    assert.match(out, /無法取得原文/);
    assert.match(out, /==須菩提==/);
    assert.match(out, /第 12 行/);
  });

  test('有劃線卻沒有書籤的檔案也會匯出', () => {
    const out = H.buildLibraryMarkdown({ bookmarks: [], highlights: [highlights[0]], docs: new Map([[FP, doc]]) });
    assert.match(out, /## T0235 金剛經\n/);
    assert.match(out, /==一時，佛在舍衛國==/);
  });

  test('會改變排版的字元被跳脫', () => {
    const d = H.plainTextOfMarkdown('一段有 *星號* 與 <b>標籤</b> 還有 a_b 的文字。');
    const h = Object.assign(H.makeAnchor(d.text, d.text.indexOf('a_b'), d.text.indexOf('a_b') + 3, d.lineStarts), { c: 'r', filePath: 'x.md' });
    const out = H.buildLibraryMarkdown({ bookmarks: [], highlights: [h], docs: new Map([['x.md', d]]) });
    assert.match(out, /==a\\_b==/);
  });
});

describe('接線', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test('備份與還原區塊有下載 Markdown 的按鈕', () => {
    const box = html.slice(html.indexOf('id="userBackupBox"'), html.indexOf('id="installSettingsSection"'));
    assert.match(box, /id="btnExportLibraryMarkdown"/);
  });

  test('app.js 綁定按鈕並以 /api/file 取原文', () => {
    assert.match(app, /\$\('btnExportLibraryMarkdown'\)/);
    assert.match(app, /function exportLibraryMarkdown\(/);
    assert.match(app, /\/api\/file\?path=/);
    assert.match(app, /HL\.buildLibraryMarkdown\(/);
  });
});

describe('匯出檔名', () => {
  test('網站站名-使用者名稱-標籤-日期', () => {
    assert.equal(H.exportFileName({ siteName: '大覺藏集', userName: '覺明', label: '書籤與劃線', date: '2026-11-02', ext: 'md' }),
      '大覺藏集-覺明-書籤與劃線-2026-11-02.md');
  });

  test('未登入省略使用者；站名空白用 mdWebview', () => {
    assert.equal(H.exportFileName({ siteName: '大覺藏集', userName: '', label: '個人偏好備份', date: '2026-11-02', ext: 'json' }),
      '大覺藏集-個人偏好備份-2026-11-02.json');
    assert.equal(H.exportFileName({ siteName: '  ', label: 'x', date: 'd', ext: '.md' }), 'mdWebview-x-d.md');
  });

  test('email 只取 @ 前；去掉檔名不合法字元', () => {
    assert.equal(H.exportFileName({ siteName: 'A/B:C*?', userName: 'ven@example.org', label: 'L', date: 'D', ext: 'md' }), 'A B C-ven-L-D.md');
    assert.equal(H.exportFileName({ siteName: '站<名>', userName: ' ..a"b|c.. ', label: 'L', date: 'D', ext: 'md' }), '站 名-a b c-L-D.md');
  });

  test('過長的名稱截斷', () => {
    assert.equal(H.safeFileNamePart('字'.repeat(80)).length, 40);
  });

  test('兩個個人匯出都用新檔名', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.match(app, /personalExportFileName\('個人偏好備份', 'json'\)/);
    assert.match(app, /personalExportFileName\('書籤與劃線', 'md'\)/);
    assert.ok(!/a\.download = `mdWebview-(user-preferences|bookmarks-highlights)/.test(app));
  });
});
