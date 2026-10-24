const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const s2t = require('../s2t.js');

describe('S2T 簡繁轉換引擎與佛教名相保護測試', () => {
  test('基本常用簡繁轉換', () => {
    assert.equal(s2t.toTraditional('汉字简化与繁体'), '漢字簡化與繁體');
    assert.equal(s2t.toTraditional('观自在菩萨'), '觀自在菩薩');
    assert.equal(s2t.toTraditional('般若波罗蜜多心经'), '般若波羅蜜多心經');
  });

  test('佛教經論與古典漢語 68 字名相保護（不可誤轉）', () => {
    // 經論常見「云何」、「云何應住」不可誤轉為「雲何」
    assert.equal(s2t.toTraditional('云何应住'), '云何應住');
    assert.equal(s2t.toTraditional('如是我闻，一时佛在舍卫国'), '如是我聞，一時佛在舍衛國');

    // 「吃茶去」不可誤轉
    assert.equal(s2t.toTraditional('吃茶去'), '吃茶去');

    // 「舍利子」不可誤轉為「捨利子」
    assert.equal(s2t.toTraditional('舍利子，色不异空'), '舍利子，色不異空');

    // 「阿耨多罗三藐三菩提」
    assert.equal(s2t.toTraditional('阿耨多罗三藐三菩提'), '阿耨多羅三藐三菩提');
  });

  test('古典文獻正字保護：20 個高佔比異體字不轉換', () => {
    // 判準：該字在 7,209 個純繁體檔（5.00 億字）中的出現次數，
    // 佔它與 OpenCC 轉換目標合計的 40% 以上 → 視為古典正字。
    const protectedChars = s2t.classicalProtected;
    assert.equal(Object.keys(protectedChars).length, 20, '應有 20 個受保護字');

    for (const [src, openccTarget] of Object.entries(protectedChars)) {
      // 字典中不得再有此字
      assert.equal(s2t.dict[src], undefined, `${src} 不應在 S2T_DICT 中`);
      // 單字轉換後必須原樣保留
      assert.equal(s2t.toTraditional(src), src, `${src} 應原樣保留`);
      // 該字的簡體原文也不該被轉（因已從字典移除）
      assert.notEqual(s2t.toTraditional(src), openccTarget, `${src} 不應轉為 ${openccTarget}`);
    }
  });

  test('古典正字保護：實際佛典詞組不被改寫', () => {
    // 大正藏原文用例
    assert.equal(s2t.toTraditional('痛痒'), '痛痒');           // 身無痛痒
    assert.equal(s2t.toTraditional('踟蹰'), '踟蹰');           // 踟蹰於內閣
    assert.equal(s2t.toTraditional('虬螭'), '虬螭');           // 蝦蟇虬螭
    assert.equal(s2t.toTraditional('若昵'), '若昵');           // 若欲、若貪、若昵
    assert.equal(s2t.toTraditional('伊昵彌'), '伊昵彌');       // 譯音，絕不可轉
    assert.equal(s2t.toTraditional('蚊虻蠅虱'), '蚊虻蠅虱');   // 蠅虱
    assert.equal(s2t.toTraditional('蜂蝎'), '蜂蝎');           // 蜂蝎
    assert.equal(s2t.toTraditional('姹女'), '姹女');           // 姹女
    assert.equal(s2t.toTraditional('馬厩'), '馬厩');           // 馬厩
    assert.equal(s2t.toTraditional('油糍'), '油糍');           // 禪宗語錄食物名
    assert.equal(s2t.toTraditional('篡弑'), '篡弑');           // 篡弑反叛
    assert.equal(s2t.toTraditional('沄沄'), '沄沄');           // 魂猶沄沄也
    assert.equal(s2t.toTraditional('摧杠'), '摧杠');           // 裂蓋摧杠
  });

  test('「呐」為語氣詞，本語料 8,605 次全非「吶喊」', () => {
    // 繁體檔中「呐」皆為語氣詞
    assert.equal(s2t.toTraditional('很鈍呐'), '很鈍呐');
    assert.equal(s2t.toTraditional('那些人呐'), '那些人呐');
    // 即使簡體「呐喊」也不再轉換——字形可辨，優先保護 8,605 次語氣詞
    assert.equal(s2t.toTraditional('呐喊'), '呐喊');
    assert.equal(s2t.dict['呐'], undefined);
  });

  test('40% 門檻以下的邊界字仍保留轉換', () => {
    // 這些字佔比 <40%，仍視為簡體，保留原轉換行為
    assert.equal(s2t.toTraditional('鐵瓮'), '鐵甕');   // 22.6%
    assert.equal(s2t.toTraditional('為肴'), '為餚');   // 34.3%
    assert.equal(s2t.toTraditional('疱瘡'), '皰瘡');   // 31.5%
    assert.equal(s2t.toTraditional('莅臨'), '蒞臨');   // 24.1%
    assert.equal(s2t.toTraditional('粮食'), '糧食');   // 5.9%
    assert.equal(s2t.toTraditional('减少'), '減少');   // 4.7%
    assert.equal(s2t.toTraditional('藴藏'), '蘊藏');   // 2.4%
  });

  test('40% 門檻新增的四字：唇、笋、兖、腭 不轉換', () => {
    assert.equal(s2t.toTraditional('脣口燋爛'.replace('脣','唇')), '唇口燋爛'); // 唇口燋爛
    assert.equal(s2t.toTraditional('冬竹抽笋'), '冬竹抽笋');
    assert.equal(s2t.toTraditional('兖國公'), '兖國公');
    assert.equal(s2t.toTraditional('燒其腭'), '燒其腭');
    // 確認這四字已不在字典
    for (const c of ['唇', '笋', '兖', '腭']) {
      assert.equal(s2t.dict[c], undefined, `${c} 不應在字典中`);
    }
  });

  test('hasSimplified 檢測功能', () => {
    assert.equal(s2t.hasSimplified('般若波罗蜜多'), true);
    assert.equal(s2t.hasSimplified('般若波羅蜜多'), false);
    assert.equal(s2t.hasSimplified('觀自在菩薩'), false);
    assert.equal(s2t.hasSimplified('观自在菩萨'), true);
    assert.equal(s2t.hasSimplified('English text 12345'), false);
  });

  test('非漢字、符號、空格與數字不變', () => {
    const mixed = 'Hello, 世界！12345 — 《金剛經》第 1 卷';
    assert.equal(s2t.toTraditional(mixed), 'Hello, 世界！12345 — 《金剛經》第 1 卷');
  });

  test('空字串與非法輸入防禦', () => {
    assert.equal(s2t.toTraditional(''), '');
    assert.equal(s2t.toTraditional(null), '');
    assert.equal(s2t.toTraditional(undefined), '');
    assert.equal(s2t.hasSimplified(''), false);
    assert.equal(s2t.hasSimplified(null), false);
    assert.equal(s2t.hasSimplified(undefined), false);
  });
});
