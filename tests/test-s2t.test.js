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
