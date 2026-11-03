/**
 * @file tests/test-kepan-ux-batch2.test.js
 *
 * 科判閱讀模式審計第二批（v4.27.8）：
 *   A4 同一部經裡沒有科判標題的篇：科判分頁留著，說明並列出本經有科判的講次；
 *   B1 不再把範圍叫「地」（搜尋「本地」、選單「另一地」）；
 *   B2／B3 講次按鈕：一段內容時一行「講次 … 共 N 講」，多段時分「內容」「講次」兩行，不寫「N／M 段」。
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require('../lib/kepan.js');
const UI = require('../kepan-sidebar.js');
const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'kepan-sidebar.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdweb-kepan-b2-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cn = ['', '一', '二', '三', '四', '五'];
function body(prefix) {
  let out = `## 甲一、${prefix}總說（分二科）\n\n文。\n\n`;
  for (let i = 1; i <= 3; i++) {
    out += `### 乙${cn[i]}、${prefix}第${cn[i]}段\n\n文。\n\n`;
    for (let j = 1; j <= 3; j++) out += `#### 丙${cn[j]}、${prefix}第${cn[i]}段之${cn[j]}\n\n文。\n\n`;
  }
  return out;
}
function write(dir, name, fm, text) {
  fs.mkdirSync(dir, { recursive: true });
  const head = '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`).join('\n') + '\n---\n';
  fs.writeFileSync(path.join(dir, name + '.md'), head + text);
}

describe('A4：沒有科判標題的篇', () => {
  const d = path.join(tmp, '金剛經');
  write(d, '0金剛經_總目錄', { title: '金剛經 總目錄', kepan: true }, '- [[1996講記]]\n- [[1998筆錄]]\n- [[1999講記]]\n');
  write(d, '1996講記', { title: '金剛經講記（1996）', round: '1996 禪七' }, body(''));
  write(d, '1998筆錄', { title: '金剛經筆錄（1998）', round: '1998 永光寺' }, '# 筆錄\n\n## 講次一\n\n文。\n');
  write(d, '1999講記', { title: '金剛經講記（1999）', round: '1999 前輯' }, body(''));

  test('lib：回傳 none 與本經有科判的講次', async () => {
    K.clearKepanCache();
    const p = await K.getKepanForFile(tmp, '金剛經/1998筆錄.md');
    assert.equal(p.none, true);
    assert.equal(p.title, '金剛經');
    assert.deepEqual(p.others.map(o => o.label), ['1996 禪七', '1999 前輯']);
    assert.ok(p.others.every(o => o.n > 0 && o.file));
    const tree = await K.getKepanForFile(tmp, '金剛經/1996講記.md');
    assert.ok(!tree.none && tree.nodes.length > 0, '有科判的篇照舊');
  });

  test('server：/api/kepan 以 nearby 回傳，kepan 仍是 null', () => {
    assert.match(SERVER, /payload\.none \? \{ kepan: null, nearby: payload \} : \{ kepan: payload \}/);
  });

  test('側欄：none 模式科判與大綱分頁都在，列出講次', () => {
    assert.match(HTML, /id="kepanNone"[^>]*hidden/);
    assert.match(JS, /setTabMode\('none'\)/);
    assert.match(JS, /kTab\.hidden = !on && !none;/);
    assert.match(JS, /data-none-file=/);
    assert.match(JS, /本篇沒有科判標題/);
  });
});

describe('B1：範圍不再叫「地」', () => {
  test('搜尋與選單用語', () => {
    assert.doesNotMatch(JS, /`（本地 /);
    assert.match(JS, /目前範圍內/);
    assert.doesNotMatch(HTML, /切換到另一地/);
  });
});

describe('B2／B3：講次按鈕', () => {
  test('一段內容：只寫講次與「共 N 講」', () => {
    const P = { rounds: [{ label: '1996 法雲寺' }, { label: '2002–2003' }], roundGroups: [{ topic: '攝大乘論', rounds: [0, 1] }], roundIndex: 1 };
    const l = UI.roundPickerLabel(P);
    assert.equal(l.content, '');
    assert.equal(l.round, '2002–2003');
    assert.equal(l.count, '共 2 講');
  });

  test('多段內容：分「內容」「講次」，不寫段', () => {
    const P = {
      rounds: [{ label: '1999 香港' }, { label: '2002 波特蘭' }, { label: '1997 紐約' }],
      roundGroups: [{ topic: '天王品', rounds: [0] }, { topic: '尊導品', rounds: [1, 2] }], roundIndex: 2,
    };
    const l = UI.roundPickerLabel(P);
    assert.equal(l.content, '尊導品');
    assert.equal(l.round, '1997 紐約');
    assert.equal(l.count, '共 2 講');
    assert.doesNotMatch(l.title, /段[^內]/);
    assert.equal(UI.roundPickerLabel({ ...P, roundIndex: 0 }).count, '', '只有一講不寫共幾講');
  });
});
