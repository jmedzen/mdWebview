# 罕見字：後備字型與朗讀讀音表

經文裡有九千多個常用字以外的漢字（擴充 A–I、相容字、部首），例如「車𤦲」的 𤦲。
Google Fonts 的 Noto Serif TC 只收其中不到 2%，所以另外提供：

| 產物 | 用途 | 由誰產生 |
| --- | --- | --- |
| `vendor/fonts/rare/rare-font.css`、`rare-*.woff2` | 網頁的後備字型 `mdRare`，排在 Noto Serif TC 後面；瀏覽器只下載頁面用到的塊 | `build-font.py` |
| `vendor/fonts/rare/server-rare-*.woff2` | 伺服器畫分享卡用（合併成一檔） | `build-font.py` |
| `lib/tts-lexicon-rare.txt` | 朗讀時把罕見字換成異體正字或同音常用字（𤦲 → 璩） | `build-readings.py` |

字型來源是字雲 Jigmo（CC0）。讀音資料來自 @mandel59/mojidata（Unicode Unihan、教育部《異體字字典》等）。
`manual.tsv` 是依語料上下文人工判讀的字，優先於自動對照。

## 語料新增罕見字之後

```sh
pip install fonttools brotli
python3 tools/rare-chars/scan.py /path/to/大覺藏集 > tools/rare-chars/chars.tsv

npm pack fontpkg-jigmo && tar xzf fontpkg-jigmo-*.tgz            # 字型在 package/
python3 tools/rare-chars/build-font.py package

npm pack @mandel59/mojidata && tar xzf mandel59-mojidata-*.tgz   # 資料庫在 package/dist/moji.db
python3 tools/rare-chars/build-readings.py package/dist/moji.db

node --test tests/test-rare-chars.test.js
```

兩個 npm 套件解在不同資料夾，避免 package/ 互相覆蓋。字型檔名帶內容雜湊，伺服器回 immutable 快取。
