#!/usr/bin/env python3
"""從字雲 Jigmo 抽出 chars.tsv 列的罕見字，切塊輸出 woff2 與 CSS（字型名稱 mdRare）。

用法：
    pip install fonttools brotli
    python3 tools/rare-chars/build-font.py /path/to/jigmo   # 資料夾內含 Jigmo.ttf、Jigmo2.ttf、Jigmo3.ttf

Jigmo（字雲，https://kamichikoichi.github.io/jigmo/ ，CC0）也可從 npm 取得：
    npm pack fontpkg-jigmo && tar xzf fontpkg-jigmo-*.tgz   # 字型在 package/

輸出 vendor/fonts/rare/：
    rare-font.css         @font-face 宣告（index.html 載入）
    rare-hot-*.woff2      出現最多的 HOT_COUNT 字（大多數頁面只會用到這幾塊）
    rare-NN-*.woff2       其餘依碼位排序、每 CHUNK_SIZE 字一塊，unicode-range 是一段連續範圍
    server-rare-*.woff2   全部字合成一檔，只給伺服器畫分享卡用（@napi-rs/canvas 同一字型名稱只認一個檔，
                          不能像瀏覽器那樣分塊）；瀏覽器不會載入
檔名帶內容雜湊，內容不變檔名就不變，瀏覽器可長期快取。

切塊方式：瀏覽器只下載 unicode-range 涵蓋頁面上文字的那幾塊。熱門字單獨一塊，
讓常見的罕見字（䟽、𦦨、𢙣…）一次到位；其餘照碼位切，CSS 才不會因列出上萬個碼位而變肥。
熱門塊宣告在最後：同一字型名稱下，後宣告的優先比對，熱門字不會再去拉碼位塊。
"""
import glob
import hashlib
import io
import os
import sys

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_chars  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(REPO, 'vendor', 'fonts', 'rare')
FAMILY = 'mdRare'
HOT_COUNT = 600
CHUNK_SIZE = 250


def ranges(cps):
    """排序後的碼位 → 'U+20000-20005, U+2000D' 這種 unicode-range 字串。"""
    cps = sorted(cps)
    out = []
    start = prev = cps[0]
    for cp in cps[1:]:
        if cp == prev + 1:
            prev = cp
            continue
        out.append((start, prev))
        start = prev = cp
    out.append((start, prev))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def make_subset(src_path, cps, flavor='woff2'):
    font = TTFont(src_path)
    opts = subset.Options()
    opts.flavor = flavor
    opts.layout_features = ['*']
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    opts.notdef_outline = True
    opts.hinting = False
    opts.desubroutinize = True
    opts.drop_tables += ['FFTM']
    s = subset.Subsetter(opts)
    s.populate(unicodes=cps)
    s.subset(font)
    font.flavor = flavor
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def main(jigmo_dir):
    sources = sorted(glob.glob(os.path.join(jigmo_dir, 'Jigmo*.ttf')))
    if not sources:
        sys.exit(f'找不到 Jigmo*.ttf：{jigmo_dir}')
    cmaps = [(p, set(TTFont(p, lazy=True).getBestCmap())) for p in sources]

    def source_of(cp):
        for p, cm in cmaps:
            if cp in cm:
                return p
        return None

    chars = load_chars()
    missing = [cp for cp, _, _ in chars if not source_of(cp)]
    have = [(cp, n) for cp, _, n in chars if source_of(cp)]
    hot = {cp for cp, _ in have[:HOT_COUNT]}

    os.makedirs(OUT_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUT_DIR, '*rare-*.woff2')):
        os.remove(old)

    faces = []          # (檔名, unicode-range)
    total = 0

    def emit(prefix, cps):
        nonlocal total
        data = make_subset(source_of(cps[0]), cps)
        name = f'{prefix}-{hashlib.sha1(data).hexdigest()[:10]}.woff2'
        with open(os.path.join(OUT_DIR, name), 'wb') as f:
            f.write(data)
        total += len(data)
        faces.append((name, ranges(cps), len(cps), len(data)))

    # 一般塊：熱門字以外，依來源檔、碼位排序切塊
    idx = 0
    for p, _ in cmaps:
        rest = sorted(cp for cp, _ in have if cp not in hot and source_of(cp) == p)
        for i in range(0, len(rest), CHUNK_SIZE):
            part = rest[i:i + CHUNK_SIZE]
            # unicode-range 用整段連續範圍，CSS 才短；範圍內沒收的字，瀏覽器會再往下一個字型找
            emit(f'rare-{idx:02d}', part)
            faces[-1] = (faces[-1][0], f'U+{part[0]:X}-{part[-1]:X}', faces[-1][2], faces[-1][3])
            idx += 1
    # 熱門塊最後宣告（優先比對）
    for j, (p, _) in enumerate(cmaps):
        part = sorted(cp for cp in hot if source_of(cp) == p)
        if part:
            emit(f'rare-hot{j}', part)

    # 伺服器用的合併檔：各來源先各自抽成 TTF，再合併成一個 woff2
    parts = []
    for p, cm in cmaps:
        cps = [cp for cp, _ in have if cp in cm and source_of(cp) == p]
        if cps:
            parts.append(io.BytesIO(make_subset(p, cps, flavor=None)))
    merged = Merger().merge(parts)
    merged.flavor = 'woff2'
    buf = io.BytesIO()
    merged.save(buf)
    data = buf.getvalue()
    server_name = f'server-rare-{hashlib.sha1(data).hexdigest()[:10]}.woff2'
    with open(os.path.join(OUT_DIR, server_name), 'wb') as f:
        f.write(data)

    css = [
        '/* 罕見字後備字型 mdRare：字雲 Jigmo（CC0）子集。',
        ' * 由 tools/rare-chars/build-font.py 產生，請勿手改；語料新增罕見字時重跑該工具。',
        f' * {len(have):,} 字、{len(faces)} 塊、合計 {total / 1024:,.0f} KB；瀏覽器只下載頁面用到的塊。 */',
    ]
    for name, rng, n, size in faces:
        css.append(
            f"@font-face{{font-family:'{FAMILY}';font-style:normal;font-weight:100 900;font-display:swap;"
            f"src:url('{name}') format('woff2');unicode-range:{rng}}} /* {n} 字 {size // 1024} KB */"
        )
    with open(os.path.join(OUT_DIR, 'rare-font.css'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(css) + '\n')

    print(f'{len(have)} 字 → {len(faces)} 塊，{total / 1024:,.0f} KB；伺服器合併檔 {len(data) / 1024:,.0f} KB；Jigmo 沒有的 {len(missing)} 字：'
          + ' '.join(f'U+{cp:X}' for cp in missing[:20]))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
