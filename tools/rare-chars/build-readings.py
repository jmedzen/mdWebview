#!/usr/bin/env python3
"""為 chars.tsv 的每個罕見字決定朗讀時要換成哪個常用字，寫成 lib/tts-lexicon-rare.txt。

用法：
    npm pack @mandel59/mojidata && tar xzf mandel59-mojidata-*.tgz   # 取得 package/dist/moji.db
    python3 tools/rare-chars/build-readings.py package/dist/moji.db

moji.db（@mandel59/mojidata）收有 Unicode Unihan、教育部《異體字字典》、《漢語大字典》等的異體對照。
換字的順序（第一個成立的就用）：
  0. tools/rare-chars/manual.tsv：依語料上下文人工判讀的字（例：𦦨 → 焰、無㝵 的 㝵 → 礙）
  1. Unicode 相容字、康熙部首：依 Unicode 規範換成對應的標準字（例：U+2F835 灰 → 灰）
  2. 異體字：換成正字（例：𤦲 → 璩、䟽 → 疏）。正字要在 Big5 常用字裡（語音模型認得），
     不在的話再找一次它的正字（例：𢙣 → 悪 → 惡）
  3. Unihan 有普通話讀音：換成同音、只有一個讀音的常用字（例：䟦 bá → 拔）
  4. 都沒有：朗讀時略過這個字（改讀為「-」）
"""
import os
import re
import sqlite3
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_chars  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(REPO, 'lib', 'tts-lexicon-rare.txt')

# 異體關係：(kdpv 關係, 依據名稱)。kdpv 的 subject 是正字、object 是異體。
VARIANT_RELS = [
    ('twedu/variant', '教育部異體字字典'),
    ('hydzd/variant', '漢語大字典'),
    ('dypytz/variant', '第一批異體字整理表'),
    ('cjkvi/variant', 'CJKVI 異體字'),
    ('cjkvi/simplified', 'CJKVI 簡繁'),
    ('hydzd/simplified', '漢語大字典簡繁'),
    ('koseki/variant', '戶籍統一文字'),
    ('jisx0213/variant', 'JIS X 0213'),
    ('jisx0212/variant', 'JIS X 0212'),
    ('ucs-scs/variant', 'UCS 異體'),
    ('jp/old-style', '日本舊字體'),
]
UNIHAN_VARIANTS = ['kTraditionalVariant', 'kSemanticVariant', 'kZVariant', 'kSpecializedSemanticVariant']




def main(db_path):
    db = sqlite3.connect(db_path)
    q = db.execute

    big5 = {r[0]: int(r[1][:4], 16) for r in q('select UCS, value from unihan_kBigFive')}

    def common(ch):
        """語音模型一定認得的字：Big5 常用字（A440–C67E）且在基本區。"""
        code = big5.get(ch)
        return code is not None and 0xA440 <= code <= 0xC67E and 0x4E00 <= ord(ch) <= 0x9FFF

    def known(ch):
        return ch in big5 and 0x4E00 <= ord(ch) <= 0x9FFF

    # 讀音
    mandarin = {}
    for ucs, i, v in q('select UCS, i, value from unihan_each_kMandarin order by UCS, i'):
        mandarin.setdefault(ucs, []).append(v)
    readings = {}
    for ucs, v in q('select UCS, value from unihan_each_kMandarin'):
        readings.setdefault(ucs, set()).add(v)
    for ucs, v in q('select UCS, value from unihan_each_kHanyuPinyin'):
        for r in v.split(':', 1)[-1].split(','):
            readings.setdefault(ucs, set()).add(r)
    pinlu = {}
    for ucs, v in q('select UCS, value from unihan_each_kHanyuPinlu'):
        m = re.match(r'(.+)\((\d+)\)', v)
        if m:
            readings.setdefault(ucs, set()).add(m.group(1))
            pinlu[(ucs, m.group(1))] = int(m.group(2))

    # 同音字：每個讀音挑一個「只有這個讀音、最常用」的常用字
    homophone = {}
    for ch in big5:
        if not common(ch):
            continue
        rs = readings.get(ch, set())
        if len(rs) != 1:
            continue
        r = next(iter(rs))
        score = pinlu.get((ch, r), 0)
        if r not in homophone or score > homophone[r][1]:
            homophone[r] = (ch, score)

    # 沒有單一讀音的常用字時，退而用「第一讀音是它」的常用字（多音字，但最常用的讀法相同）
    for ch in big5:
        if not common(ch):
            continue
        first = (mandarin.get(ch) or [''])[0]
        if not first or first in homophone:
            continue
        score = pinlu.get((ch, first), 0)
        key = '~' + first
        if key not in homophone or score > homophone[key][1]:
            homophone[key] = (ch, score)
    for key in [k for k in homophone if k.startswith('~')]:
        homophone.setdefault(key[1:], homophone.pop(key))

    # 異體 → 正字
    variant_of = {}
    for rel, label in VARIANT_RELS:
        for subj, obj in q('select subject, object from kdpv where rel = ?', (rel,)):
            variant_of.setdefault(obj, []).append((subj, label))
    for prop in UNIHAN_VARIANTS:
        for ucs, v in q(f'select UCS, value from unihan_each_{prop}'):
            m = re.match(r'U\+([0-9A-F]+)', v)
            if m:
                variant_of.setdefault(ucs, []).append((chr(int(m.group(1), 16)), f'Unihan {prop}'))

    def standard_of(ch, depth=0):
        for target, label in variant_of.get(ch, []):
            if target != ch and known(target):
                return target, label
        if depth == 0:
            for target, label in variant_of.get(ch, []):
                if target != ch:
                    hit = standard_of(target, 1)
                    if hit:
                        return hit[0], f'{label}→{hit[1]}'
        return None

    manual = {}
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manual.tsv'), encoding='utf-8') as f:
        for line in f:
            if line.strip() and not line.startswith('#'):
                ch, to = line.rstrip('\n').split('\t')[:2]
                manual[ch] = to

    rows = []
    stats = {}
    for cp, block, count in load_chars():
        ch = chr(cp)
        to, how = '', ''
        if ch in manual:
            to, how = manual[ch], '語料上下文判讀'
        norm = unicodedata.normalize('NFKC' if block in ('Radicals', 'Strokes') else 'NFC', ch)
        if not to and norm != ch and len(norm) == 1 and known(norm):
            to, how = norm, 'Unicode 相容字' if block not in ('Radicals', 'Strokes') else 'Unicode 康熙部首'
        if not to:
            hit = standard_of(ch)
            if hit:
                to, how = hit
        reading = (mandarin.get(ch) or [''])[0]
        if not to and reading and reading in homophone:
            to, how = homophone[reading][0], 'Unihan 讀音（同音字）'
        if not to:
            to, how = '-', '查無異體與讀音：朗讀略過'
        if ch in manual and to != '-':
            reading = (mandarin.get(to) or [''])[0]
        if not reading and to != '-':
            reading = (mandarin.get(to) or [''])[0]
        stats[how.split('→')[0]] = stats.get(how.split('→')[0], 0) + count
        rows.append(f'{ch}｜{to}｜{reading}｜{how}')

    head = [
        '# 罕見字讀音表（內建，自動產生）— mdWebview 朗讀用',
        '#',
        '# 由 tools/rare-chars/build-readings.py 產生，請勿手改；要改某個字的讀法，請在後台「讀音校正」的自訂字典寫「字｜改讀為」。',
        '# 格式：字｜改讀為｜普通話讀音｜依據。改讀為「-」＝朗讀時略過這個字。畫面上的經文不變。',
        '# 字表來源：tools/rare-chars/chars.tsv（大覺藏集語料中常用字以外的字）。',
        '# 異體與讀音資料：@mandel59/mojidata（Unicode Unihan、教育部《異體字字典》、《漢語大字典》等）。',
        '',
    ]
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(head + rows) + '\n')
    total = sum(stats.values())
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f'{k}\t{v:,}\t{v / total * 100:.1f}%')
    print(f'{len(rows)} 字 → {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
