"""Conditional lyric retention, as the owner defined it on 2026-10-07.

Of the OCR rows the lyric detector (e2) selected on a page and that match true lyric references, how many does the
pipeline retain as lyric suggestions? "True lyric reference" is the native score's own lyric text for the measures the page
shows (all verses). A row is genuine when its letters (accents and punctuation removed, at least MIN_LETTERS) occur in the
page's native lyric letters; shorter rows are too ambiguous to match by text and are left out of the denominator and
counted separately. Retained means the scanner offers the row as a lyric (proposedLyric), i.e. after the semantic gate and
the backend's own filters. This is conditional retention only: detection misses, OCR accuracy and note attachment are
separate questions.
"""

import argparse
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from math import sqrt
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent / "overlay"))

from engine_vs_native import parse_rhythm_parts
from score_direction_placement import SOURCES, align, fetch, native_candidates

MIN_LETTERS = 3


def letters(text):
    folded = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in folded if c.isalpha() and not unicodedata.combining(c))


def native_letters(native_root, native_part_index, start, length):
    """Concatenated lyric letters of the native part's measures [start, start+length), one string per verse."""
    parts = native_root.findall("part")
    verses = {}
    for part in parts:
        for measure in part.findall("measure")[start : start + length]:
            for note in measure.findall("note"):
                for lyric in note.findall("lyric"):
                    text = "".join(t.text or "" for t in lyric.findall("text"))
                    verses.setdefault(lyric.get("number") or "1", []).append(text)
    return ["".join(letters(t) for t in texts) for texts in verses.values()]


def wilson(k, n, z=1.645):
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return round((c - r) / d, 4), round((c + r) / d, 4)


def best_alignment(page_root, natives):
    page_parts = parse_rhythm_parts(page_root)
    best = None
    for native_root in natives:
        for i, part in enumerate(page_parts):
            for j, native in enumerate(parse_rhythm_parts(native_root)):
                if not part or not native:
                    continue
                start, score = align(part, native)
                if score >= 0.7 and (best is None or score > best[0]):
                    best = (score, native_root, j, start, len(part))
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    pages, totals, misses = [], Counter(), []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
        natives = [r for _, r in native_candidates(score, catalogue)]
        if not natives:
            continue
        xml = ET.fromstring(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token))
        aligned = best_alignment(xml, natives)
        if aligned is None:
            pages.append({"page": page, "status": "not aligned"})
            continue
        _, native_root, j, start, length = aligned
        verses = native_letters(native_root, j, start, length)
        if not any(verses):
            pages.append({"page": page, "status": "no native lyrics in the window"})
            continue
        candidates = json.loads(fetch(f"{args.api}/{job['jobId']}/pages/1/lyric-candidates", args.token))
        rows = [r for r in candidates["ocrRows"] if r.get("kind") in (None, "lyric")]
        counted = Counter()
        for row in rows:
            text = letters(row.get("text") or "")
            if len(text) < MIN_LETTERS:
                counted["too short to match"] += 1
                continue
            if not any(text in verse for verse in verses):
                counted["not a native lyric (excluded)"] += 1
                continue
            counted["genuine"] += 1
            if row.get("proposedLyric"):
                counted["retained"] += 1
            else:
                misses.append({"page": page, "text": row.get("text"), "reason": row.get("withheldReason"), "semantic": row.get("semantic"), "semanticScore": row.get("semanticScore")})
        pages.append({"page": page, "status": "ok", **counted})
        totals.update(counted)
        print(page, dict(counted), flush=True)
    genuine, retained = totals["genuine"], totals["retained"]
    summary = {"pagesScored": sum(1 for p in pages if p["status"] == "ok"), "genuineRows": genuine, "retained": retained, "retention": round(retained / genuine, 4) if genuine else None, "interval90": wilson(retained, genuine), "tooShort": totals["too short to match"], "notNativeLyric": totals["not a native lyric (excluded)"], "target": 0.95}
    args.out.write_text(json.dumps({"summary": summary, "misses": misses, "pages": pages}, indent=1))
    print(json.dumps(summary))
    for m in misses[:25]:
        print("  missed:", m)


if __name__ == "__main__":
    main()
