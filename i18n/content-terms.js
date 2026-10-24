/**
 * 簡體顯示的用語修正表（OpenCC 轉換之後套用）
 *
 * 鍵是 OpenCC 轉換「後」的簡體字串，值是希望顯示的字串。OpenCC 以一般
 * 語料為準，少數佛學名相會被轉錯，例如「乾慧地」的「乾」是乾燥義，
 * 卻被當成「幹／乾」一律轉為「干」。
 *
 * 新增條目：
 *   1. 在 node 中確認錯誤輸出，例如
 *        const O = require('./vendor/opencc/t2cn.js');
 *        O.Converter({ from: 'tw', to: 'cn' })('乾慧地')   // → '干慧地'
 *   2. 把 ['錯誤輸出', '正確輸出'] 加到 content（經文、辭典）或 ui（介面）。
 *      儘量用完整詞彙而非單字，以免誤傷其他詞（「干」本身大多是對的）。
 *   3. 在 tests/test-display-script.test.js 補一筆名相樣本。
 */
(function (global) {
  'use strict';

  const MDW_CONVERT_TERMS = {
    // 經文、辭典、搜尋結果等內文區（OpenCC tw → cn 逐字轉換之後）
    content: [
      ['干慧地', '乾慧地'],
      ['干陀罗', '乾陀罗'],
      ['干达婆', '乾达婆']
    ],
    // 介面區（OpenCC twp → cn 詞彙轉換之後）
    ui: [
      ['拷贝链接', '复制链接'],
      ['拷贝', '复制'],
      ['辞典查找', '辞典查询'],
      ['预设', '默认']
    ]
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MDW_CONVERT_TERMS;
  }
  if (typeof window !== 'undefined') {
    window.MDW_CONVERT_TERMS = MDW_CONVERT_TERMS;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
