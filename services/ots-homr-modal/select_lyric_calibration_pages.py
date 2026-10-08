"""Deterministically pick a bounded calibration subset for the pinned e2 lyric detector.

Uses only the calibration partition. Lieder pages with known lyric positives contribute at most
`--lieder-per-score` pages per score; OSSQ pages with Lyrics marked complete-negative (instrumental)
contribute at most `--ossq-per-score`. Order is by pixel hash, never by detector output.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

MAX_PIXELS = 12_000_000


def select(rows, lieder_per_score, ossq_per_score):
    groups = defaultdict(list)
    for row in rows:
        if row["partition"] != "calibration" or row["width"] * row["height"] > MAX_PIXELS:
            continue
        if row["corpus"] == "lieder" and any(g["semanticFamily"] == "Lyrics" for g in row["ground_truth"]):
            groups[("lieder", row["score"])].append(row)
        elif row["corpus"] == "ossq" and "Lyrics" in row["complete_semantic_families"]:
            groups[("ossq", row["score"])].append(row)
    chosen = []
    for (corpus, _), pages in sorted(groups.items()):
        limit = lieder_per_score if corpus == "lieder" else ossq_per_score
        chosen.extend(sorted(pages, key=lambda r: r["pixel_sha256"])[:limit])
    return chosen


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--lieder-per-score", type=int, default=2)
    parser.add_argument("--ossq-per-score", type=int, default=5)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.pages.open()]
    chosen = select(rows, args.lieder_per_score, args.ossq_per_score)
    with args.out.open("x") as handle:
        for row in chosen:
            handle.write(json.dumps(row) + "\n")
    print(len(chosen), "pages;", len({r["score"] for r in chosen}), "scores")
