DancingScript-700.ttf — Dancing Script (Impallari Type), SIL Open Font License 1.1.
Source: https://fonts.google.com/specimen/Dancing+Script
用於分享早安圖 Q 版型的英文問候（lib/share-card-server.js 啟動時載入；程式內建，不靠網路下載）。


================================================================
Inter 與 Noto Serif TC —— 網頁字型，自架（SIL Open Font License 1.1）
================================================================

【為什麼】
index.html 原本向 fonts.googleapis.com 取 Inter 與 Noto Serif TC，那是整個網站
唯一的外部請求。它與 README「核心程式都放在自己的網站上，不依賴外部服務」的
承諾矛盾，而且在離線、或在中國大陸等 Google Fonts 不可達的網路環境下，字型會
掉回系統字，經文的排版因此走樣。改為自架後，這兩件事一起解決。

【檔案】
  inter/inter.css                  @font-face 表（拉丁與常用符號）
  inter/inter-400|600|700.woff2    三個字重的子集（各約 38 KB）
  noto-serif-tc.css                @font-face 表（228 條：兩個字重 × 114 段）
  noto-serif-tc/w400/*.woff2       400 字重的切片
  noto-serif-tc/w700/*.woff2       700 字重的切片

【怎麼切的】
Noto Serif TC 的完整字型約 9.5 MB／字重。本藏有 7,444 篇經論，用到的相異非 ASCII
字元有 25,598 個，其中 14,097 個是 Noto Serif TC 有收錄的；剩下 11,501 個是藏文、
梵文轉寫、天城文等 Noto Serif TC 本來就沒有的字，任何情況下都會落到系統字，
差別只在「有沒有下載一個永遠用不到的字型檔」。

所以切片分兩類：
  1. 主切片：沿用 Google 原本的 unicode-range 分段（108 段），但每一段只放
     「本藏真的用到、且落在這一段」的字，並用 pyftsubset 重新產生。
  2. orphan 切片（6 段）：Google 的 unicode-range 沒有涵蓋、但本藏真的用到的
     3,378 個罕用字，例如 䭾（《瑜伽師地論》）、𦦨（《大日經》）、叅、跢。
     沒有這 6 段，這些字會無聲地變成豆腐方塊。

瀏覽器只下載「當前頁面文字命中的段」。實測：
  一部《金剛般若波羅蜜經》：42 段、約 1.4 MB
  同樣這一頁用 Google 的原始切法：42 段、約 2.9 MB
因為每段都只裝真正會用到的字，所以同樣的段數下檔案小了一半。

【怎麼重建】
需要 Python 的 fonttools（含 brotli、zopfli）：

  python3 -m venv /tmp/ftenv && /tmp/ftenv/bin/pip install fonttools brotli zopfli

  1. 掃 md/ 與 dicts/ 以及 index.html、app.js、style.css 等介面檔，統計字頻
     （含 ASCII 可視字元與全形標點）。
  2. 以 Google Fonts 的 css2 介面取得兩件事：原始 unicode-range 分段，
     以及「舊版 UA」會回傳的完整 TTF（curl 時帶
     -A "Mozilla/5.0 (Windows NT 5.1)"）。
  3. 對每一段做 pyftsubset：
       pyftsubset NotoSerifTC-400.ttf --text-file=段內文字 \
         --flavor=woff2 --layout-features='*' --with-zopfli \
         --output-file=noto-serif-tc/w400/sN.woff2
  4. 由 charfreq 與 subset 結果反推每段的 unicode-range，寫成 noto-serif-tc.css
     （相鄰碼位合併為 U+XXXX-YYYY）。

重建後請確認：vendor/fonts/ 下的 woff2 總數為 2 × 114 個，且
`node --test tests/test-fonts-selfhosted.test.js` 通過。

【授權】
Inter — Copyright (c) 2016 The Inter Project Authors，SIL Open Font License 1.1。
Noto Serif TC — Copyright 2012 Google Inc.，SIL Open Font License 1.1。
兩者的 OFL 全文可在 https://scripts.sil.org/OFL 取得。
自架與子集化為 OFL 明確允許；本專案未修改字形設計，只做子集與格式轉換。
