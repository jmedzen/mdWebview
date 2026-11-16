#!/usr/bin/env python3
"""掃描經文資料夾，列出常用字（U+4E00–9FFF）以外的漢字與出現次數，寫成 chars.tsv。

用法：
    python3 tools/rare-chars/scan.py /path/to/大覺藏集 > tools/rare-chars/chars.tsv

語料新增了罕見字之後跑這支，再跑 build-font.py 與 build-readings.py。
"""
import collections
import os
import sys

BLOCKS = [
    ('ExtA', 0x3400, 0x4DBF), ('CompatIdeo', 0xF900, 0xFAFF),
    ('ExtB', 0x20000, 0x2A6DF), ('ExtC', 0x2A700, 0x2B73F), ('ExtD', 0x2B740, 0x2B81F),
    ('ExtE', 0x2B820, 0x2CEAF), ('ExtF', 0x2CEB0, 0x2EBEF), ('ExtI', 0x2EBF0, 0x2EE5F),
    ('CompatSup', 0x2F800, 0x2FA1F), ('ExtG', 0x30000, 0x3134F), ('ExtH', 0x31350, 0x323AF),
    ('ExtJ', 0x323B0, 0x3347F),
    ('PUA', 0xE000, 0xF8FF), ('SPUA', 0xF0000, 0x10FFFF),
    ('Radicals', 0x2E80, 0x2FDF), ('Strokes', 0x31C0, 0x31EF),
]


def block_of(cp):
    for name, lo, hi in BLOCKS:
        if lo <= cp <= hi:
            return name
    return None


def main(root):
    counts = collections.Counter()
    nfiles = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for name in filenames:
            if not name.endswith('.md') or name.startswith('.'):
                continue
            nfiles += 1
            with open(os.path.join(dirpath, name), encoding='utf-8', errors='replace') as f:
                for ch in f.read():
                    cp = ord(ch)
                    if cp >= 0x2E80 and block_of(cp):
                        counts[cp] += 1
    out = sys.stdout
    out.write(f'# 大覺藏集語料中「常用字（U+4E00–9FFF）以外」的漢字與出現次數；由 scan.py 產生（{nfiles:,} 個 .md）\n')
    out.write('# codepoint\tblock\tcount\n')
    for cp, n in sorted(counts.items(), key=lambda x: (-x[1], x[0])):
        out.write(f'U+{cp:04X}\t{block_of(cp)}\t{n}\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
