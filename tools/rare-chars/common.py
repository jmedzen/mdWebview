"""chars.tsv 的讀取（build-font.py、build-readings.py 共用）。"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CHARS_TSV = os.path.join(HERE, 'chars.tsv')
SKIP_BLOCKS = {'PUA', 'SPUA'}   # 私用區：不同來源代表不同的字，字型與讀音都無法判斷


def load_chars(path=CHARS_TSV):
    """[(codepoint, block, count)]，依出現次數由多到少；略過私用區。"""
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            cp, block, count = line.rstrip('\n').split('\t')[:3]
            if block in SKIP_BLOCKS:
                continue
            out.append((int(cp[2:], 16), block, int(count)))
    out.sort(key=lambda x: (-x[2], x[0]))
    return out
