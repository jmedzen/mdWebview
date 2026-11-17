/**
 * 朗讀（TTS）的標準斷句、章節後備與選取吸附（tts-segment.js，純函式）。
 *
 * 這些判斷條件寫死在 tts-segment.js 的常數裡；規則一改，部分句子的快取就會失效，
 * 所以每一條都有對應的測試。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Seg = require('../tts-segment.js');

const texts = (doc, opts) => Seg.segmentDoc(doc, opts).units.filter((u) => u.kind !== 'skip').map((u) => u.text);
const kinds = (doc, opts) => Seg.segmentDoc(doc, opts).units.map((u) => u.kind);

describe('正規化', () => {
  test('去掉 Markdown 記號、註腳、HTML、圖片；連結只留顯示字', () => {
    assert.equal(Seg.normalizeLine('## **般若**[^1]與<sup>2</sup>`空`').t, '般若與2空');
    assert.equal(Seg.normalizeLine('見[[長老-如何栽培善根|前一篇]]與[目錄](toc.md)。').t, '見前一篇與目錄。');
    assert.equal(Seg.normalizeLine('前![圖](a.png)後').t, '前後');
    assert.equal(Seg.normalizeLine('經文[0001a01]續[＊]文').t, '經文續文');
    assert.equal(Seg.normalizeLine('> - 引文').t, '- 引文');
  });

  test('連續空白（含全形空格）收成一個，頭尾不留', () => {
    assert.equal(Seg.normalizeLine('  歸命彼世尊　　應供等覺者  ').t, '歸命彼世尊 應供等覺者');
  });

  test('表格逐列讀：直線換成空白', () => {
    assert.equal(Seg.normalizeLine('| 色 | 受 |', true).t, '色 受');
  });

  test('位移對照指回原行', () => {
    const raw = '**如是**我聞';
    const { t, map } = Seg.normalizeLine(raw);
    assert.equal(t, '如是我聞');
    assert.equal(raw[map[0]], '如');
    assert.equal(raw[map[2]], '我');
  });
});

describe('不朗讀單位與非經文區段', () => {
  test('YAML front matter、CBETA // 頁首、程式碼區塊不產生單位', () => {
    const doc = '---\ntitle: x\n---\n\n//【經文資訊】大正藏\n//----\n\n```\ncode\n```\n\n如是我聞，一時佛在舍衛國。\n';
    assert.deepEqual(texts(doc), ['如是我聞，一時佛在舍衛國。']);
  });

  test('純編號、[TOC]、No. 行、頁碼、Email 是 skip，但保留在清單裡', () => {
    const doc = '四〇\n\n（廿五）\n\n[TOC]\n\nNo. 37 [No. 27(51), No. 36]\n\nPAGE 28\n\nTape66\n\nfoo@example.org\n\n）\n\n正文一句話在這裡。\n';
    const u = Seg.segmentDoc(doc).units;
    assert.deepEqual(u.map((x) => x.kind), ['skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'sent']);
    assert.ok(u.slice(0, 8).every((x) => x.spoken === undefined));
  });

  test('「版權說明」「目錄」標題下的內容預設不讀，遇到同級標題恢復', () => {
    const doc = '# 經名\n\n正文第一段在這裡。\n\n# 版權說明\n\n本資料庫可自由流通。\n\n# 第二章\n\n正文第二段在這裡。\n';
    assert.deepEqual(texts(doc), ['經名', '正文第一段在這裡。', '第二章', '正文第二段在這裡。']);
    assert.ok(texts(doc, { readNonScripture: true }).includes('本資料庫可自由流通。'));
  });

  test('整行只有連結的導覽列不朗讀；句子裡的連結照讀', () => {
    assert.deepEqual(kinds('[[長老-如何栽培善根|前一篇]] · [[0入決定勝_總目錄|目錄]] · [[長老-持名念佛|後一篇]]\n'), ['skip']);
    assert.deepEqual(kinds('[上一頁](a.md) | [下一頁](b.md)\n'), ['skip']);
    assert.deepEqual(texts('詳見[[大智度論|《大智度論》]]卷第一的說明。\n'), ['詳見《大智度論》卷第一的說明。']);
  });

  test('只剩標點的片段不朗讀', () => {
    assert.deepEqual(kinds('……\n'), ['skip']);
  });
});

describe('散文切分', () => {
  test('句讀切開，結尾引號黏在前一句', () => {
    assert.deepEqual(texts('爾時世尊告諸比丘眾言：「愛訒深有，榮色未起。」諸比丘聞佛所說，歡喜奉行。\n'),
      ['爾時世尊告諸比丘眾言：', '「愛訒深有，榮色未起。」', '諸比丘聞佛所說，歡喜奉行。']);
  });

  test('問答引導冒號後切開並標為 intro；不足 8 字的片段併入下一句', () => {
    const u = Seg.segmentDoc('時，長老須菩提在大眾中而白佛言：「希有世尊！如來善護念諸菩薩。」\n').units;
    assert.equal(u[0].kind, 'intro');
    assert.equal(u[0].text, '時，長老須菩提在大眾中而白佛言：');
    assert.deepEqual(texts('是故。須菩提當知此義甚深。\n'), ['是故。須菩提當知此義甚深。']);
    // 「佛言：」只有三個字，併入後面的引文（否則會有大量極短的音檔）
    assert.deepEqual(texts('佛言：「善哉善哉，汝今諦聽。」\n'), ['佛言：「善哉善哉，汝今諦聽。」']);
  });

  test('成對引號內不切強切點；段首未收的「不算引號內（跨段引文慣例）', () => {
    assert.deepEqual(texts('世尊告諸比丘眾言：「善哉。善哉。汝今諦聽。」爾時大眾默然而住。\n'),
      ['世尊告諸比丘眾言：', '「善哉。善哉。汝今諦聽。」', '爾時大眾默然而住。']);
    assert.deepEqual(texts('「癡緣所生，亦為有本。何等為本？眩曜色聲，五蓋馳惑，斯生癡本矣。\n'),
      ['「癡緣所生，亦為有本。', '何等為本？眩曜色聲，五蓋馳惑，斯生癡本矣。']);
  });

  test('半形括號與全形括號同樣配對，不在內部切', () => {
    assert.deepEqual(texts('此義甚深(如前所說。其義云何)今當略說其中要義。\n', { readNotes: true }),
      ['此義甚深(如前所說。其義云何)今當略說其中要義。']);
    assert.deepEqual(texts('此義甚深（如前所說。其義云何）今當略說其中要義。\n', { readNotes: true }),
      ['此義甚深（如前所說。其義云何）今當略說其中要義。']);
  });

  test('超過上限的句子在最接近中點的次級標點切，不超過上限', () => {
    const long = '若卵生、若胎生、若濕生、若化生，'.repeat(12) + '我皆令入無餘涅槃而滅度之。';
    const u = texts(long + '\n', { maxLen: 60 });
    assert.ok(u.length >= 4);
    assert.ok(u.every((t) => t.length <= 60), u.map((t) => t.length).join(','));
    assert.equal(u.join(''), long);
  });

  test('無標點的長行：每 36 字固定切，並標示斷句為自動推測', () => {
    const line = '觀自在菩薩行深般若波羅蜜多時照見五蘊皆空度一切苦厄'.repeat(8);
    const d = Seg.segmentDoc(line + '\n');
    const u = d.units.map((x) => x.text);
    assert.ok(u.every((t) => t.length <= 120));
    assert.ok(d.stats.hardCuts > 0);
    assert.equal(d.stats.guessed, true);
    assert.equal(u.join(''), line);
  });

  test('句長上限可調且夾在 40–200', () => {
    const line = '如是，'.repeat(100);
    assert.ok(texts(line, { maxLen: 40 }).every((t) => t.length <= 40));
    assert.ok(texts(line, { maxLen: 5 }).every((t) => t.length <= 40));
    assert.ok(texts(line, { maxLen: 9999 }).every((t) => t.length <= 200));
  });

  test('不切開讀音字典的詞、連續英數字、短夾注', () => {
    const lex = [['阿耨多羅三藐三菩提', '']];
    const line = '發' + '阿耨多羅三藐三菩提'.repeat(30) + '心';
    for (const t of texts(line + '\n', { lexicon: lex, maxLen: 40 })) {
      assert.ok(!/^(耨|多|羅|三|藐|菩|提)/.test(t) || t.startsWith('阿'), t.slice(0, 12));
    }
    const m = '唵(引)阿里迦(二合)摩細娑嚩(二合引)賀'.repeat(12);
    for (const t of Seg.segmentDoc(m + '\n', { maxLen: 40 }).units.map((x) => x.text)) {
      assert.ok(!/^[^(]*\)/.test(t), `cut inside a parenthetical: ${t.slice(0, 16)}`);
    }
  });

  test('不跨行合併：行尾沒有句號也在行尾結束', () => {
    assert.deepEqual(texts('第一行沒有句號的文字\n第二行接著寫下去的文字\n'), ['第一行沒有句號的文字', '第二行接著寫下去的文字']);
  });
});

describe('偈頌與咒語', () => {
  test('多行整齊偈頌四小句一個單位，可跨行', () => {
    const u = Seg.segmentDoc('諸法從緣起　如來說是因\n彼法因緣盡　是大沙門說\n諸惡莫作　眾善奉行\n').units;
    assert.equal(u[0].kind, 'verse');
    assert.equal(u[0].text, '諸法從緣起 如來說是因 彼法因緣盡 是大沙門說');
    assert.equal(u[0].line, 1); assert.equal(u[0].endLine, 2);
    assert.equal(u[0].a, 0); assert.equal(u[0].b, 11);
    assert.equal(u[0].spoken, '諸法從緣起，如來說是因，彼法因緣盡，是大沙門說');
    assert.equal(u[1].kind, 'verse'); // 小句字數不同（四字），自成另一組
    assert.notEqual(u[1].group, u[0].group);
  });

  test('有標點的單行偈頌需四小句以上；空白分隔的需兩小句以上', () => {
    assert.deepEqual(kinds('佛法從來不在多，祇須體究自彌陀。憤然直要親相見，念念追尋莫放他。\n'), ['verse']);
    assert.deepEqual(kinds('歸命彼世尊　應供等覺者\n'), ['verse']);
    assert.deepEqual(kinds('色不異空，空不異色。\n'), ['sent']);
  });

  test('引導句之後的偈頌：同一段落內也分得開', () => {
    const u = Seg.segmentDoc('爾時世尊而說偈言：\n一切有為法　如夢幻泡影\n如露亦如電　應作如是觀\n').units;
    assert.deepEqual(u.map((x) => x.kind), ['intro', 'verse']);
    assert.equal(u[1].group, 'v1');
  });

  test('咒語：整行為一個語義組，注音括號不讀', () => {
    const u = Seg.segmentDoc('「唵(引)阿里迦(二合)摩細娑嚩(二合引)賀怛姪他唵囉嚩吽」\n').units;
    assert.equal(u[0].kind, 'mantra');
    assert.ok(u[0].group.startsWith('m'));
    assert.ok(!/[()引合]/.test(u[0].spoken), u[0].spoken);
    assert.equal(Seg.mantraLike('一時佛在舍衛國祇樹給孤獨園與大比丘眾千二百五十人俱'), false);
  });
});

describe('標題與章節四層後備', () => {
  test('# 標題與卷品文字行獨立成句；文字行需單獨成段、≤ 30 字、無句讀', () => {
    const u = Seg.segmentDoc('# 金剛經\n\n法會因由分第一\n\n如是我聞，一時佛在舍衛國。\n\n此分第一，義甚深。\n').units;
    assert.deepEqual(u.map((x) => [x.kind, x.level]), [['heading', 1], ['heading', 0], ['sent', undefined], ['sent', undefined]]);
    assert.equal(u[1].strict, true);
  });

  test('第 1 層：# 標題 ≥ 4 個', () => {
    const doc = ['# 一', '甲段文字內容。', '# 二', '乙段文字內容。', '# 三', '丙段文字內容。', '# 四', '丁段文字內容。'].join('\n\n') + '\n';
    const c = Seg.detectChapters(Seg.segmentDoc(doc).units);
    assert.equal(c.layer, 1);
    assert.deepEqual(c.chapters.map((x) => x.title), ['一', '二', '三', '四']);
  });

  test('第 2 層：只有 1–3 個 # 標題但有卷品文字行；卷尾重複的標題不開新章', () => {
    const doc = ['# 優婆塞戒經', '優婆塞戒經卷第一', '集會品第一', '善生言：世尊，云何菩薩。', '優婆塞戒經卷第一', '優婆塞戒經卷第二', '發菩提心品第二', '善男子，眾生發心。', '優婆塞戒經卷第二(終)'].join('\n\n') + '\n';
    const c = Seg.detectChapters(Seg.segmentDoc(doc).units);
    assert.equal(c.layer, 2);
    assert.deepEqual(c.chapters.map((x) => x.title), ['優婆塞戒經', '優婆塞戒經卷第一', '集會品第一', '優婆塞戒經卷第二', '發菩提心品第二']);
  });

  test('第 3 層：沒有標題時以段首發端詞分章（前一章已累積 1500 字）', () => {
    const para = '須菩提，於意云何，可以身相見如來不。'.repeat(50); // 900 字
    const doc = [para, para, '爾時，須菩提白佛言。' + para, para].join('\n\n') + '\n';
    const c = Seg.detectChapters(Seg.segmentDoc(doc).units);
    assert.equal(c.layer, 3);
    assert.equal(c.chapters.length, 2);
  });

  test('第 4 層：保底固定字數；超過 5000 字的章再細切，結果都不超過 5000 字', () => {
    const para = '一切法無我無人無眾生無壽者。'.repeat(60); // 840 字
    const doc = Array.from({ length: 20 }, () => para).join('\n\n') + '\n';
    const c = Seg.detectChapters(Seg.segmentDoc(doc).units);
    assert.equal(c.layer, 4);
    assert.ok(c.chapters.length >= 5);
    assert.ok(c.chapters.every((x) => x.chars <= 5000));
    const big = '# 唯一的標題\n\n# 二\n\n# 三\n\n# 四\n\n' + doc;
    const c2 = Seg.detectChapters(Seg.segmentDoc(big).units);
    assert.equal(c2.layer, 1);
    assert.ok(c2.chapters.every((x) => x.chars <= 5000));
    assert.ok(c2.chapters.some((x) => x.part));
  });

  test('章節連續涵蓋所有單位', () => {
    const doc = '# 甲\n\n一段文字。\n\n品第一\n\n另一段文字在此。\n';
    const d = Seg.segmentDoc(doc); const c = Seg.detectChapters(d.units);
    assert.equal(c.chapters[0].from, 0);
    assert.equal(c.chapters[c.chapters.length - 1].to, d.units.length);
    for (let i = 1; i < c.chapters.length; i++) assert.equal(c.chapters[i].from, c.chapters[i - 1].to);
  });
});

describe('口語化與讀音字典', () => {
  test('字典在斷句之後套用：替換不改變切法，只改 spoken', () => {
    const doc = '般若波羅蜜多心經，南無觀世音菩薩。\n';
    const a = Seg.segmentDoc(doc).units; const b = Seg.segmentDoc(doc, { lexicon: [['般若', '波惹'], ['南無', '拿摩']] }).units;
    assert.deepEqual(a.map((u) => u.text), b.map((u) => u.text));
    assert.equal(b[0].spoken, '波惹波羅蜜多心經，拿摩觀世音菩薩。');
  });

  test('較長的詞優先', () => {
    const u = Seg.segmentDoc('般若波羅蜜多甚深微妙。\n', { lexicon: [['般若', 'X'], ['般若波羅蜜多', 'Y']] }).units;
    assert.equal(u[0].spoken, 'Y甚深微妙。');
  });

  test('夾注預設不讀，readNotes 時照讀', () => {
    assert.equal(Seg.segmentDoc('舍利弗（智慧第一）白佛言世尊。\n').units[0].spoken, '舍利弗白佛言世尊。');
    assert.equal(Seg.segmentDoc('舍利弗（智慧第一）白佛言世尊。\n', { readNotes: true }).units[0].spoken, '舍利弗（智慧第一）白佛言世尊。');
  });

  test('parseLexicon：全形與半形直線、註解、只保護不替換', () => {
    assert.deepEqual(Seg.parseLexicon('# 註解\n般若｜波惹\n南無|拿摩\n須菩提\n\n般若｜重複\n'), [['般若', '波惹'], ['南無', '拿摩'], ['須菩提', '']]);
  });
});

describe('核心不變式：斷句與選取、起點無關', () => {
  const doc = [
    '# 緣本致經', '聞如是：',
    '一時，佛在舍衛國祇樹給孤獨園。佛告諸比丘：「愛訒深有，榮色未起，為纏沒住，亦有本栽，非無緣致。愛有耽荒，本致熟在，狂醉為受，不明觀解，是名癡本。',
    '「癡緣所生，亦為有本。何等為本？眩曜色聲，五蓋馳惑，斯生癡本矣。',
    '爾時世尊而說偈言：\n諸法從緣起　如來說是因\n彼法因緣盡　是大沙門說',
    '佛說是已，諸比丘聞佛所說，歡喜奉行。'
  ].join('\n\n') + '\n';

  test('只重新斷某一段，結果與整篇斷句中的那一段完全相同', () => {
    const whole = Seg.segmentDoc(doc).units;
    const blocks = doc.split(/\n\s*\n/);
    let bi = 0;
    for (const b of blocks) {
      if (!b.trim()) continue;
      const local = Seg.segmentDoc(b + '\n').units.map((u) => u.spoken || '');
      const expected = whole.filter((u) => u.block === bi).map((u) => u.spoken || '');
      assert.deepEqual(local, expected, `block ${bi}`);
      bi++;
    }
  });

  test('改散文中的一個字，變動的句子 ≤ 2', () => {
    const before = Seg.segmentDoc(doc).units.map((u) => u.spoken);
    const after = Seg.segmentDoc(doc.replace('眩曜色聲', '眩曜佛聲')).units.map((u) => u.spoken);
    const set = new Set(after);
    assert.ok(before.filter((s) => !set.has(s)).length <= 2);
  });

  test('結果是確定性的', () => {
    assert.deepEqual(Seg.segmentDoc(doc).units, Seg.segmentDoc(doc).units);
  });
});

describe('選取吸附', () => {
  const doc = [
    '# 經名',                                                         // line 1
    '如是我聞：',                                                     // 3
    '一時，佛在舍衛國祇樹給孤獨園。爾時，世尊食時，著衣持鉢，入舍衛大城乞食。', // 5
    '佛告須菩提：',                                                   // 7
    '「諸菩薩摩訶薩應如是降伏其心。所有一切眾生之類，我皆令入無餘涅槃而滅度之。」如是滅度無量眾生。', // 9
    '爾時世尊而說偈言：\n一切有為法　如夢幻泡影\n如露亦如電　應作如是觀\n諸法從緣起　如來說是因\n彼法因緣盡　是大沙門說', // 11–15
    '# 第二',                                                         // 17
    '復次，須菩提，菩薩於法應無所住。'                                 // 19
  ].join('\n\n') + '\n';
  const units = Seg.segmentDoc(doc).units;
  const at = (text) => units.findIndex((u) => u.text.startsWith(text));
  const snap = (line, a, b, endLine) => Seg.snapSelection(units, { line, off: a }, { line: endLine || line, off: b });
  const played = (r) => units.slice(r.from, r.to + 1).filter((u) => u.kind !== 'skip').map((u) => u.text);

  test('選句中兩個字：延伸到完整句', () => {
    const r = snap(5, 18, 20);
    assert.deepEqual(played(r), ['爾時，世尊食時，著衣持鉢，入舍衛大城乞食。']);
    assert.equal(r.selFrom, r.selTo);
    assert.equal(r.flags.extended, undefined);
  });

  test('只選引導句：跨段落納入下一句', () => {
    const r = snap(7, 0, 3);
    assert.deepEqual(played(r), ['佛告須菩提：', '「諸菩薩摩訶薩應如是降伏其心。所有一切眾生之類，我皆令入無餘涅槃而滅度之。」']);
    assert.equal(r.flags.intro, true); assert.equal(r.flags.extended, true);
  });

  test('只選引文開頭：往前納入引導句', () => {
    const r = snap(9, 1, 4);
    assert.equal(played(r)[0], '佛告須菩提：');
  });

  test('選到偈頌的一部分：納入整組，並帶上前面的引導句', () => {
    const r = snap(13, 0, 3);
    const p = played(r);
    assert.deepEqual(p, ['爾時世尊而說偈言：', '一切有為法 如夢幻泡影 如露亦如電 應作如是觀', '諸法從緣起 如來說是因 彼法因緣盡 是大沙門說']);
    assert.equal(r.flags.group, true);
  });

  test('太短就補句，預設往後；不越過標題', () => {
    const r = snap(3, 0, 2); // 「如是我聞：」是引導句，會納入下一句
    assert.ok(played(r).length >= 2);
    const tail = snap(19, 0, 2);
    assert.equal(units[tail.from].kind, 'sent');
    assert.ok(tail.from > at('第二'));
    const lastOfCh1 = snap(15, 0, 3);
    assert.ok(lastOfCh1.to < at('第二'), '補句不得越過標題');
  });

  test('使用者自己選到標題時，標題照讀', () => {
    const r = snap(17, 0, 2, 19);
    assert.ok(played(r).includes('第二'));
  });

  test('引號補全超過上限就放棄並標示未完整補全', () => {
    const inner = '善男子，菩薩應當如是修學。'.repeat(30);
    const d2 = Seg.segmentDoc(`佛言：「${inner}」諸比丘歡喜奉行。\n`).units;
    const r = Seg.snapSelection(d2, { line: 1, off: 4 }, { line: 1, off: 6 }); // 選到含「的第一句
    assert.equal(r.flags.incomplete, true);
    assert.equal(r.from, 0); assert.equal(r.to, 0);
    // 選引文中間（不含引號）的句子：不擴展
    const mid = d2[2];
    const r2 = Seg.snapSelection(d2, { line: 1, off: mid.a + 1 }, { line: 1, off: mid.a + 3 });
    assert.equal(r2.from, mid.i); assert.equal(r2.to, mid.i);
    // 短引文：補全到收尾的引號
    const d3 = Seg.segmentDoc('世尊告諸比丘眾言：「善哉善哉。汝今諦聽，當為汝說。」諸比丘歡喜奉行。\n').units;
    const r3 = Seg.snapSelection(d3, { line: 1, off: 10 }, { line: 1, off: 12 });
    assert.equal(r3.flags.incomplete, undefined);
    assert.ok(d3.slice(r3.from, r3.to + 1).map((u) => u.text).join('').includes('當為汝說。」'));
  });

  test('段尾未收的引號只算到段尾：選兩個字不會被擴成整段以外', () => {
    const d2 = Seg.segmentDoc('「癡緣所生，亦為有本。何等為本？眩曜色聲，五蓋馳惑。\n\n「五蓋蔽冥，致影沈吟，亦為有本。\n').units;
    const r = Seg.snapSelection(d2, { line: 1, off: 1 }, { line: 1, off: 3 });
    assert.ok(d2.slice(r.from, r.to + 1).every((u) => u.block === 0));
  });

  test('選取落在沒有單位的地方回傳 null', () => {
    assert.equal(Seg.snapSelection(units, { line: 2, off: 0 }, { line: 2, off: 5 }), null);
    assert.equal(Seg.snapSelection([], { line: 1, off: 0 }, { line: 1, off: 5 }), null);
  });

  test('選取產生的句子全部是整篇斷句的句子（日後可重用）', () => {
    const all = new Set(units.map((u) => u.spoken));
    for (let line = 1; line <= 19; line += 2) for (let a = 0; a < 30; a += 7) {
      const r = snap(line, a, a + 5, Math.min(19, line + (a % 3) * 2));
      if (!r) continue;
      for (const t of units.slice(r.from, r.to + 1)) if (t.kind !== 'skip') assert.ok(all.has(t.spoken));
      assert.ok(r.from <= r.selFrom && r.to >= r.selTo);
    }
  });
});
