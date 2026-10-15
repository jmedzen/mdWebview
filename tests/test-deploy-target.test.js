/**
 * @file tests/test-deploy-target.test.js
 *
 * mdWebview serves two very different deployments from one codebase:
 * a public multi-user site (`web`) and a single-user desktop/mobile bundle
 * (`mac-app`, `win-app`, …). The deployment target is the single switch that
 * decides whether an administrator account, SEO and analytics exist, so its
 * validation and its authorization consequences must be exact.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const constants = require('../lib/constants.js');
const { isLoopbackRequest } = require('../lib/auth.js');

describe('部署目標（MDW_DEPLOY_TARGET）模型', () => {
  test('合法值皆可正規化，且包含使用者的五個目標', () => {
    for (const target of ['web', 'mac-app', 'win-app', 'ios-app', 'android-app']) {
      assert.equal(
        constants.normalizeDeployTarget(target),
        target,
        `${target} 必須被視為合法值`
      );
    }
  });

  test('大小寫與前後空白皆可容忍', () => {
    assert.equal(constants.normalizeDeployTarget('  WIN-APP  '), 'win-app');
    assert.equal(constants.normalizeDeployTarget('Mac-App'), 'mac-app');
    assert.equal(constants.normalizeDeployTarget('WEB'), 'web');
  });

  test('未設定或空字串一律回退 web（fail-closed）', () => {
    assert.equal(constants.normalizeDeployTarget(undefined), 'web');
    assert.equal(constants.normalizeDeployTarget(null), 'web');
    assert.equal(constants.normalizeDeployTarget(''), 'web');
    assert.equal(constants.normalizeDeployTarget('   '), 'web');
    assert.equal(constants.isUnknownDeployTarget(''), false, '空字串不算「未知值」');
    assert.equal(constants.isUnknownDeployTarget(undefined), false);
  });

  test('無法辨識的值回退 web 並可被偵測為未知（供啟動時警告）', () => {
    for (const bogus of ['bogus', 'desktop', 'windows-app', 'web2', 'macapp']) {
      assert.equal(
        constants.normalizeDeployTarget(bogus),
        'web',
        `未知值 ${bogus} 必須回退 web`
      );
      assert.equal(
        constants.isUnknownDeployTarget(bogus),
        true,
        `${bogus} 應被回報為未知值，以便啟動時警告`
      );
    }
  });

  test('web 不是單機模式；其餘五個目標都是單機模式', () => {
    assert.equal(constants.DEPLOY_TARGETS.includes('web'), true);
    assert.equal(constants.SINGLE_USER_TARGETS.includes('web'), false,
      'web 不得被歸類為單機模式');
    for (const target of constants.SINGLE_USER_TARGETS) {
      assert.equal(constants.DEPLOY_TARGETS.includes(target), true,
        `${target} 必須同時是合法的部署目標`);
    }
  });

  test('每個目標都有可讀標籤（供啟動日誌與 UI 顯示）', () => {
    assert.equal(typeof constants.DEPLOY_TARGET_LABEL, 'string');
    assert.ok(constants.DEPLOY_TARGET_LABEL.length > 0);
  });
});

describe('迴環（loopback）來源判定與偽造防護', () => {
  const reqWith = (remoteAddress, headers) => ({
    socket: { remoteAddress },
    headers: headers || {}
  });

  test('IPv4 迴環區段全部視為本機', () => {
    for (const addr of ['127.0.0.1', '127.0.0.5', '127.255.255.254']) {
      assert.equal(isLoopbackRequest(reqWith(addr)), true, `${addr} 應視為本機`);
    }
  });

  test('IPv6 ::1 與 IPv4-mapped 形式皆視為本機', () => {
    // Node reports IPv4-mapped addresses this way on dual-stack listeners.
    assert.equal(isLoopbackRequest(reqWith('::1')), true);
    assert.equal(isLoopbackRequest(reqWith('::ffff:127.0.0.1')), true);
    assert.equal(isLoopbackRequest(reqWith('::ffff:127.0.0.99')), true);
  });

  test('私有與公開網段皆不視為本機', () => {
    for (const addr of ['192.168.1.9', '10.0.0.1', '172.16.5.4', '203.0.113.7',
                        '::ffff:192.168.1.9', '2001:db8::1']) {
      assert.equal(isLoopbackRequest(reqWith(addr)), false, `${addr} 不應視為本機`);
    }
  });

  test('缺少 socket 或位址時回傳 false（不得預設放行）', () => {
    assert.equal(isLoopbackRequest({}), false);
    assert.equal(isLoopbackRequest({ socket: {} }), false);
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: '' } }), false);
    assert.equal(isLoopbackRequest(null), false);
    assert.equal(isLoopbackRequest(undefined), false);
  });

  test('偽造代理標頭不得取得本機身分（權限提升防護）', () => {
    // getClientIP() honours these headers when TRUST_PROXY is enabled, so a
    // remote caller could claim to be 127.0.0.1. The loopback check must use the
    // unspoofable TCP peer address instead.
    const forged = reqWith('203.0.113.7', {
      'x-forwarded-for': '127.0.0.1',
      'cf-connecting-ip': '127.0.0.1',
      'true-client-ip': '127.0.0.1',
      'x-real-ip': '127.0.0.1'
    });
    assert.equal(isLoopbackRequest(forged), false,
      '遠端來源不得因 X-Forwarded-For 等標頭而被視為本機');
  });

  test('128.0.0.1 之類的相似位址不誤判', () => {
    assert.equal(isLoopbackRequest(reqWith('128.0.0.1')), false);
    assert.equal(isLoopbackRequest(reqWith('1127.0.0.1')), false);
  });
});
