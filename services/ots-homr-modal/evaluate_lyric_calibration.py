"""Evaluate the pinned fusion-v1 lyric calibration on an UNTOUCHED partition; fit nothing.

Applies the manifest's own size gate and accept line to held-out e2 detections. Without new human
judgements, precision is reported as bounds: `matchedShare` (matched / all accepted vocal boxes) is a
lower bound on precision, and `projected` applies the calibration-set judged lyric rate to the
unmatched boxes. Instrumental pages give an exact false-positive rate. The manifest is not changed.
"""

import argparse
import json
from pathlib import Path

from calibration_manifest import load_calibration_manifest
from fit_lyric_calibration import load_pages, tall_box_rate
from lyric_calibration_sample import candidates


def evaluate(pages, manifest, judged_rate):
    min_area = manifest.min_box_area.get("Lyrics", 0)
    gated = [{**p, "boxes": [b for b in p["boxes"] if b["area"] >= min_area]} for p in pages]
    threshold = manifest.accept_threshold("lyrics")("Lyrics")
    rows = []
    for row in candidates(gated):
        calibrated = manifest.calibrate("lyrics", "Lyrics", row["rawConfidence"])
        row["accepted"] = calibrated is not None and calibrated >= threshold
        rows.append(row)
    accepted = [r for r in rows if r["accepted"]]
    vocal = [r for r in accepted if r["status"] != "negative"]
    matched = sum(1 for r in vocal if r["status"] == "matched")
    unmatched = len(vocal) - matched
    instrumental_pages = len({p["id"] for p in pages if p["corpus"] == "ossq"})
    false_positives = sum(1 for r in accepted if r["status"] == "negative")
    # Per-score matched share, to show spread rather than one pooled number.
    by_score = {}
    for r in vocal:
        entry = by_score.setdefault(r["score"], [0, 0])
        entry[0] += r["status"] == "matched"
        entry[1] += 1
    shares = sorted(m / n for m, n in by_score.values() if n >= 5)
    return {
        "acceptThreshold": threshold,
        "pages": {"vocal": len(pages) - instrumental_pages, "instrumental": instrumental_pages},
        "acceptedVocalBoxes": len(vocal),
        "matched": matched,
        "unmatched": unmatched,
        "matchedShare": (matched / len(vocal)) if vocal else None,
        "projectedPrecision": ((matched + judged_rate * unmatched) / len(vocal)) if vocal else None,
        "judgedLyricRateAssumed": judged_rate,
        "instrumentalFalsePositives": false_positives,
        "falsePositivesPerInstrumentalPage": (false_positives / instrumental_pages) if instrumental_pages else None,
        "perScoreMatchedShare": {
            "scores": len(shares),
            "min": shares[0] if shares else None,
            "median": shares[len(shares) // 2] if shares else None,
            "max": shares[-1] if shares else None,
        },
        "tallBoxProxy": tall_box_rate(gated),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--detections", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--fit-report", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = load_calibration_manifest(args.manifest)
    fit = json.loads(args.fit_report.read_text())
    accepted_bands = [b for b in fit["bands"] if b["lowerEdge"] >= fit["acceptLowerEdge"]]
    usable = sum(b["usable"] for b in accepted_bands)
    rate = sum(b["judgedLyricRate"] * b["usable"] for b in accepted_bands) / usable
    result = {"policyRevision": manifest.policy_revision, **evaluate(load_pages(args.detections), manifest, rate)}
    args.out.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({k: result[k] for k in ("acceptedVocalBoxes", "matchedShare", "projectedPrecision", "falsePositivesPerInstrumentalPage")}))
