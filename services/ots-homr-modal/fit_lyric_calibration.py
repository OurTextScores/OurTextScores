"""Fit the pinned-e2 lyric calibration from detections plus human judgements; write a report.

Vocal-page precision per confidence band comes from lyric_calibration_sample.fit. Instrumental
(verified-negative) pages are reported as false positives per page by band, never pooled into the
precision. A score-grouped bootstrap gives a 90% interval per band. The accept line is the lowest
band edge whose calibrated precision reaches the PRESPECIFIED target; it is not tuned afterwards.
"""

import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

from lyric_calibration_sample import EDGES, candidates, fit

TARGET_PRECISION = 0.90
#: The same size gate the manifest pins (geometry.minBoxArea / maxPageAreaFraction). Lyrics area 200
#: follows the component-area sweep proposal; the fit sees exactly the boxes fusion will.
MIN_BOX_AREA = {"Lyrics": 200, "Tempo": 200, "StaffText": 200, "Expression": 200, "Dynamic": 50}
MAX_PAGE_AREA_FRACTION = 0.25
BOOTSTRAPS = 500


def apply_size_gate(pages):
    """Drop e2 boxes the fusion size gate would reject; returns (pages, dropped count)."""
    dropped = 0
    gated = []
    for page in pages:
        kept = [b for b in page["boxes"] if b["area"] >= MIN_BOX_AREA["Lyrics"]]
        dropped += len(page["boxes"]) - len(kept)
        gated.append({**page, "boxes": kept})
    return gated, dropped


def load_pages(directory):
    pages = []
    for path in sorted(Path(directory).glob("detections-*.jsonl")):
        pages.extend(json.loads(line) for line in path.read_text().splitlines())
    return pages


def negative_rates(rows, negative_pages):
    """Verified-negative boxes per instrumental page at/above each band edge."""
    result = []
    for index, edge in enumerate(EDGES):
        count = sum(1 for r in rows if r["status"] == "negative" and r["band"] >= index)
        result.append(
            {
                "rawAtLeast": edge,
                "falsePositives": count,
                "perInstrumentalPage": (count / negative_pages) if negative_pages else None,
            }
        )
    return result


def bootstrap(rows, judgements, seed=20261008):
    """Score-grouped resample of vocal rows; per-band 5th/95th percentile of the PAV fit."""
    vocal = [r for r in rows if r["status"] != "negative"]
    by_score = defaultdict(list)
    for r in vocal:
        by_score[r["score"]].append(r)
    scores = sorted(by_score)
    rng = random.Random(seed)
    draws = [[] for _ in EDGES]
    for _ in range(BOOTSTRAPS):
        sample = []
        for score in (rng.choice(scores) for _ in scores):
            sample.extend(by_score[score])
        try:
            fitted = fit(sample, judgements)
        except ValueError:
            continue  # a resample with an unjudged unmatched band; skip rather than guess
        for index, band in enumerate(fitted):
            if band.get("calibrated") is not None:
                draws[index].append(band["calibrated"])
    intervals = []
    for values in draws:
        values.sort()
        intervals.append(
            [values[int(0.05 * len(values))], values[int(0.95 * len(values)) - 1]] if len(values) >= 20 else None
        )
    return intervals


def tall_box_rate(pages, floor=0.6, ratio=1.6):
    """Share of vocal-page boxes at/above `floor` taller than `ratio` x their page's median height.

    A geometric proxy for boxes that stack several lyric lines. Boxes spanning several words on one
    line are not visible to it, so it is a lower bound on multi-lyric boxes, not a count of them.
    """
    total = tall = 0
    for page in pages:
        if page["corpus"] == "ossq":
            continue
        boxes = [b for b in page["boxes"] if b["rawConfidence"] >= floor]
        if len(boxes) < 4:
            continue
        heights = sorted(b["box"][3] - b["box"][1] for b in boxes)
        median = heights[len(heights) // 2]
        total += len(boxes)
        tall += sum(1 for h in (b["box"][3] - b["box"][1] for b in boxes) if h > ratio * median)
    return {"boxes": total, "taller": tall, "rate": (tall / total) if total else None, "ratio": ratio, "rawAtLeast": floor}


def choose_accept(bands):
    for band in bands:
        if band.get("calibrated") is not None and band["calibrated"] >= TARGET_PRECISION:
            return band
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--detections", type=Path, required=True)
    parser.add_argument("--judgements", type=Path, required=True)
    parser.add_argument("--sample-key", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--accept-lower-edge",
        type=float,
        help="Owner override of the prespecified accept line; recorded as a post-hoc choice",
    )
    args = parser.parse_args()
    pages, dropped = apply_size_gate(load_pages(args.detections))
    rows = list(candidates(pages))
    key = {r["id"]: r for r in json.loads(args.sample_key.read_text())}
    export = json.loads(args.judgements.read_text())
    if export.get("schemaVersion") != "ots.lyric-box-judgements.v1":
        raise ValueError("Unsupported judgement export")
    judgements = export["judgements"]
    if set(judgements) - set(key):
        raise ValueError("Judgement for an item outside the sample")
    if set(key) - set(judgements):
        raise ValueError("Sample items without a judgement; finish judging before fitting")
    vocal = [r for r in rows if r["status"] != "negative"]
    if args.accept_lower_edge is not None:
        # An accept line inside a pooled band cannot bind (every raw score in the band maps to
        # one calibrated value). Pool everything below the chosen line into the lowest band so the
        # line is a real boundary of the calibration.
        cut = EDGES.index(args.accept_lower_edge)
        for r in vocal:  # vocal rows only: negative rates keep their own raw bands
            if r["band"] < cut:
                r["band"] = 0
    bands = fit(vocal, judgements)
    intervals = bootstrap(vocal, judgements)
    for band, interval in zip(bands, intervals):
        band["calibratedInterval90"] = interval
    prespecified = choose_accept(bands)
    accept = prespecified
    choice = {"rule": "prespecified-target", "target": TARGET_PRECISION}
    if args.accept_lower_edge is not None:
        accept = next((b for b in bands if b["lowerEdge"] == args.accept_lower_edge), None)
        if accept is None or accept.get("calibrated") is None:
            raise ValueError("Override edge is not a populated band")
        choice = {
            "rule": "owner-override-post-hoc",
            "prespecifiedLowerEdge": prespecified["lowerEdge"] if prespecified else None,
            "reason": "Lower instrumental-page false positives at the same calibrated precision; "
            "chosen after seeing held-out results, not before.",
        }
    negative_pages = len({p["id"] for p in pages if p["corpus"] == "ossq"})
    report = {
        "schemaVersion": "ots.lyric-calibration-fit.v1",
        "targetPrecision": TARGET_PRECISION,
        "matchCoverage": 0.5,
        "pages": {"vocal": sum(p["corpus"] != "ossq" for p in pages), "instrumental": negative_pages},
        "scores": {"vocal": len({p["score"] for p in pages if p["corpus"] != "ossq"})},
        "bands": bands,
        "negativeRates": negative_rates(rows, negative_pages),
        "acceptChoice": choice,
        "acceptLowerEdge": accept["lowerEdge"] if accept else None,
        "acceptCalibrated": accept["calibrated"] if accept else None,
        "definition": (
            "Precision is P(box contains lyric text) on a vocal page. A box that spans several words "
            "or stacked lyric lines still counts as lyric text; the judging could not separate them."
        ),
        "tallBoxProxy": tall_box_rate(pages),
        "sizeGate": {
            "minBoxArea": MIN_BOX_AREA,
            "maxPageAreaFraction": MAX_PAGE_AREA_FRACTION,
            "lyricBoxesDropped": dropped,
        },
        "caveats": [
            "Detector training membership was reconstructed (fusion-v1-training-membership-audit.json): about 80% of the "
            "Lieder scores here sat in the OCR-first training pool. On the 29 verifiably clean scores the matched share "
            "is 57.8% against 51.3% on possibly-trained scores, and the judged lyric rate at raw 0.7+ is 18/19 against "
            "63/70, so there is no sign of inflation; the clean judged sample is only 19 boxes.",
            "Matched boxes are true by OCR/score agreement; unmatched boxes use a sampled human rate.",
            "Boxes below raw 0.5 were not sampled; the bins carry no information about them.",
        ],
    }
    args.out.write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps({k: report[k] for k in ("acceptLowerEdge", "acceptCalibrated")}))


if __name__ == "__main__":
    main()
