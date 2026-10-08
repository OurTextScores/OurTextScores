"""Qualify lyric OCR rows against each score's own source lyrics (no new human labels).

`run`: OCR every selected page with the shipped pipeline, using the e2 boxes already collected.
`score`: a row is LYRIC-LIKE when most of its tokens match the score's source syllables (exactly, or
within one edit for tokens of 4+ characters). It reports, per membership stratum:
  precision of proposed rows (share lyric-like), what the gate withheld, gate retention of lyric-like
  rows, and the exact-token share among lyric-like rows (an OCR exactness proxy).
Source lyrics are per score, not per page, so there is no per-page recall. A token matching common
words by coincidence can inflate lyric-likeness; tokens shorter than 2 characters are ignored.
"""

import argparse
import json
import re
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


def fold(text):
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def tokens(text):
    return [t for t in re.split(r"[^\w']+|_", fold(text)) if len(t) >= 2]


def source_vocabulary(entries):
    """Syllable and joined-word forms from source entries, per score."""
    vocab = defaultdict(set)
    for entry in entries:
        for part in tokens(entry["text"]):
            vocab[entry["score"]].add(part)
    return vocab


def edit_leq_one(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    if len(a) == len(b):
        return a[i + 1 :] == b[i + 1 :]
    return a[i:] == b[i + 1 :]


def classify_token(token, vocab):
    if token in vocab:
        return "exact"
    if len(token) >= 4 and any(edit_leq_one(token, v) for v in vocab if abs(len(v) - len(token)) <= 1):
        return "near"
    return "none"


def lyric_like(text, vocab, minimum=0.6):
    parts = tokens(text)
    if not parts:
        return None, []
    kinds = [classify_token(t, vocab) for t in parts]
    share = sum(k != "none" for k in kinds) / len(kinds)
    return share >= minimum, kinds


def summarize(rows):
    out = {"rows": len(rows)}
    scored = [r for r in rows if r["lyricLike"] is not None]
    proposed = [r for r in scored if r["proposed"]]
    withheld = [r for r in scored if not r["proposed"]]
    like = [r for r in scored if r["lyricLike"]]
    out["scoredRows"] = len(scored)
    out["proposed"] = len(proposed)
    out["proposedLyricLike"] = sum(r["lyricLike"] for r in proposed)
    out["proposedPrecision"] = (out["proposedLyricLike"] / len(proposed)) if proposed else None
    out["withheld"] = len(withheld)
    out["withheldLyricLike"] = sum(r["lyricLike"] for r in withheld)
    out["gateRetention"] = (sum(r["proposed"] for r in like) / len(like)) if like else None
    kinds = Counter(k for r in like for k in r["kinds"])
    total = sum(kinds.values())
    out["exactTokenShareInLyricRows"] = (kinds["exact"] / total) if total else None
    out["nearTokenShareInLyricRows"] = (kinds["near"] / total) if total else None
    return out


def run(args):
    import cv2

    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    pipeline = LyricTextPipeline(SemanticGate.load(), threads=args.threads)
    pages = [json.loads(line) for line in args.detections.read_text().splitlines()]
    mine = [p for i, p in enumerate(pages) if i % args.shards == args.shard]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if args.out.exists():
        for line in args.out.read_text().splitlines():
            try:
                done.add(json.loads(line)["id"])
            except json.JSONDecodeError:
                break
    with args.out.open("a") as handle:
        for page in mine:
            if page["id"] in done:
                continue
            tick = time.monotonic()
            image = cv2.imread(page["image"])
            boxes = [b["box"] for b in page["boxes"] if b["rawConfidence"] >= 0.5]
            result = pipeline.lyric_rows(image, boxes)
            handle.write(json.dumps({"id": page["id"], "score": page["score"], "seconds": time.monotonic() - tick, **result}) + "\n")
            handle.flush()
            print(f"shard {args.shard} {page['score']} {len(result['rows'])} rows", flush=True)


def score(args):
    entries = [json.loads(line) for line in args.source.read_text().splitlines()]
    vocab = source_vocabulary(entries)
    strata = json.loads(args.strata.read_text())
    rows = []
    for path in sorted(args.rows.glob("rows-*.jsonl")):
        for line in path.read_text().splitlines():
            page = json.loads(line)
            if page["score"] not in vocab:
                continue
            for row in page["rows"]:
                verdict, kinds = lyric_like(row["text"], vocab[page["score"]])
                rows.append(
                    {
                        "score": page["score"],
                        "stratum": strata.get(page["score"], "unknown"),
                        "text": row["text"],
                        "proposed": row["proposedLyric"],
                        "lyricLike": verdict,
                        "kinds": kinds,
                    }
                )
    by_stratum = defaultdict(list)
    for row in rows:
        by_stratum[row["stratum"]].append(row)
        by_stratum["ALL"].append(row)
    report = {
        "schemaVersion": "ots.lyric-ocr-qualification.v1",
        "scores": len({r["score"] for r in rows}),
        "strata": {k: summarize(v) for k, v in sorted(by_stratum.items())},
        "examples": {
            "proposedNotLyricLike": [r["text"] for r in rows if r["proposed"] and r["lyricLike"] is False][:25],
            "withheldLyricLike": [r["text"] for r in rows if not r["proposed"] and r["lyricLike"]][:25],
        },
        "limits": [
            "Lyric-likeness is agreement with the score's source syllables, not a human judgement.",
            "Source lyrics are per score; there is no per-page recall.",
            "Tokens under 2 characters are ignored; common words can match by coincidence.",
        ],
    }
    args.out.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: v for k, v in report["strata"]["ALL"].items()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--detections", type=Path, required=True)
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--shard", type=int, required=True)
    r.add_argument("--shards", type=int, required=True)
    r.add_argument("--threads", type=int, default=2)
    s = sub.add_parser("score")
    s.add_argument("--rows", type=Path, required=True)
    s.add_argument("--source", type=Path, required=True)
    s.add_argument("--strata", type=Path, required=True)
    s.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args) if args.cmd == "run" else score(args)
