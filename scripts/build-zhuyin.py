#!/usr/bin/env python3
"""Build web/vendor/zhuyin.json, the dictionary of the on-screen keyboard's Zhuyin (注音) mode (web/js/osk.js).

Source: McBopomofo (小麥注音) data, MIT licence — https://github.com/openvanilla/McBopomofo (Source/Data):
  BPMFBase.txt      character  reading  pinyin  code  class      (class "big5" = common Traditional characters)
  BPMFMappings.txt  phrase  reading-of-each-character...
  phrase.occ        phrase-or-character  frequency
plus the Chinese names of countries / places in web/data/countries.json and places.json, so that the associated-word
bar suggests destination names (剛 -> 果, 果民主共和國) ahead of everyday words.

Usage (from the repo root):
  git clone --depth 1 https://github.com/openvanilla/McBopomofo /tmp/McBopomofo
  python scripts/build-zhuyin.py /tmp/McBopomofo/Source/Data

Output {"v": 1, "c": {reading: "chars by frequency"}, "a": {char: ["suffix", ...]}}, readings written as typed on the
keyboard: initial + medial + final + tone mark (first tone has no mark; neutral tone "˙" at the end).
"""
import json
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'web' / 'vendor' / 'zhuyin.json'
MAX_CHARS_PER_READING = 60   # candidates kept for one syllable
MAX_ASSOC = 10               # associated suffixes kept per character
MIN_PHRASE_FREQ = 30         # everyday phrases below this frequency are not suggested
CJK = lambda s: all('㐀' <= ch <= '鿿' or '豈' <= ch <= '﫿' for ch in s)


def read_lines(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                yield line.split()


def main(src):
    src = Path(src)
    freq = {}
    for cols in read_lines(src / 'phrase.occ'):
        if len(cols) >= 2 and cols[1].isdigit():
            freq[cols[0]] = int(cols[1])

    names = []
    countries = json.loads((ROOT / 'web/data/countries.json').read_text(encoding='utf-8'))
    names += [c.get('zh', '') for c in countries.values()]
    places = json.loads((ROOT / 'web/data/places.json').read_text(encoding='utf-8'))
    names += [p.get('zh', '') for p in places.get('places', [])]
    names = [unicodedata.normalize('NFKC', n).strip() for n in names]
    names = sorted({n for n in names if len(n) >= 2 and CJK(n)}, key=lambda n: (-freq.get(n, 0), len(n), n))
    name_chars = {ch for n in names for ch in n}

    # character readings; weight each reading of a heteronym by how often phrases use it
    readings = defaultdict(list)  # char -> [reading]
    for cols in read_lines(src / 'BPMFBase.txt'):
        if len(cols) < 5:
            continue
        ch, rd, cls = cols[0], cols[1], cols[-1]
        if len(ch) != 1 or not CJK(ch):
            continue
        if cls not in ('big5', 'big5e') and ch not in name_chars:
            continue
        if rd not in readings[ch]:
            readings[ch].append(rd)

    evidence = defaultdict(int)  # (char, reading) -> summed frequency of phrases using it
    for cols in read_lines(src / 'BPMFMappings.txt'):
        word, rds = cols[0], cols[1:]
        if len(word) < 2 or len(word) != len(rds):
            continue
        f = freq.get(word, 1)
        for ch, rd in zip(word, rds):
            evidence[(ch, rd)] += f

    by_reading = defaultdict(list)  # reading -> [(score, char)]
    for ch, rds in readings.items():
        base = freq.get(ch, 1)
        total = sum(evidence[(ch, r)] for r in rds) + len(rds)
        for i, r in enumerate(rds):
            share = (evidence[(ch, r)] + 1) / total
            if not evidence[(ch, r)] and i == 0:
                share = max(share, 0.5)   # BPMFBase lists the main reading first
            by_reading[r].append((base * share, ch))
    cand = {}
    for r, lst in by_reading.items():
        lst.sort(key=lambda x: (-x[0], x[1]))
        cand[r] = ''.join(ch for _, ch in lst[:MAX_CHARS_PER_READING])

    # associated words: destination names first, then frequent everyday phrases
    assoc = defaultdict(list)
    def add(word):
        head, tail = word[0], word[1:]
        if tail and tail not in assoc[head] and len(assoc[head]) < MAX_ASSOC:
            assoc[head].append(tail)
    for n in names:
        add(n)
    phrases = [w for w, f in freq.items() if 2 <= len(w) <= 4 and f >= MIN_PHRASE_FREQ and CJK(w)]
    phrases.sort(key=lambda w: (-freq[w], w))
    for w in phrases:
        if w[0] in readings:
            add(w)

    out = {'v': 1, 'src': 'McBopomofo (MIT) + SafeTravel place names', 'c': cand, 'a': dict(assoc)}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT.relative_to(ROOT)}: {len(cand)} readings, {sum(map(len, cand.values()))} characters, '
          f'{len(assoc)} associated heads, {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
