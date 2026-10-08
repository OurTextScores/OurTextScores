"""Reconstruct which calibration/test scores the pinned e2/e4 detectors could have trained on.

The pinned weights are the 2026-08-30 `detector_e2.pth` / `detector_e4.pth` (SHA-256 verified by the
caller). They trained on a synthetic patch bank plus scan patches from the OCR-first Lieder pool
(`ocrshard_*` / `ocr121shard_*` id lists), split by score with
`sha256(f"{seed}:{score}")[:8] / 0xFFFFFFFF < valid_fraction` (seed 0, fraction 0.1, folder-name score id).
A score is VERIFIABLY CLEAN if it is outside the pool or lands on the validation side; every other pool
score is "possibly trained" (OCR-first output may have produced no mask for it, so this is an upper bound).
OSSQ pages were not part of the scan-mask pool; whether OSSQ scores appear in the synthetic bank is not
verified here.
"""

import argparse
import hashlib
import json
from pathlib import Path

from evaluate_lyric_calibration import evaluate
from calibration_manifest import load_calibration_manifest
from fit_lyric_calibration import load_pages

SEED, VALID_FRACTION = 0, 0.1


def is_valid(score, seed=SEED, fraction=VALID_FRACTION):
    return int(hashlib.sha256(f"{seed}:{score}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < fraction


def membership(score, corpus, pool):
    if corpus == "ossq":
        return "ossq-unverified"
    if score not in pool:
        return "clean-not-in-pool"
    return "clean-hash-valid" if is_valid(score) else "possibly-trained"


def stratify(pages, pool, manifest, judged_rate):
    groups = {}
    for page in pages:
        groups.setdefault(membership(page["score"], page["corpus"], pool), []).append(page)
    result = {}
    for name, members in sorted(groups.items()):
        row = evaluate(members, manifest, judged_rate)
        result[name] = {
            "pages": len(members),
            "scores": len({p["score"] for p in members}),
            "acceptedVocalBoxes": row["acceptedVocalBoxes"],
            "matchedShare": row["matchedShare"],
            "instrumentalFalsePositives": row["instrumentalFalsePositives"],
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pool-lists", type=Path, nargs="+", required=True)
    parser.add_argument("--detections", type=Path, nargs="+", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--judged-rate", type=float, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    pool = set()
    for path in args.pool_lists:
        pool |= set(path.read_text().split())
    pages = [p for directory in args.detections for p in load_pages(directory)]
    manifest = load_calibration_manifest(args.manifest)
    strata = stratify(pages, pool, manifest, args.judged_rate)
    clean = [p for p in pages if membership(p["score"], p["corpus"], pool).startswith("clean")]
    pooled = evaluate(clean, manifest, args.judged_rate)
    report = {
        "schemaVersion": "ots.detector-training-membership-audit.v1",
        "policyRevision": manifest.policy_revision,
        "poolScores": len(pool),
        "split": {"seed": SEED, "validFraction": VALID_FRACTION},
        "strata": strata,
        "cleanPooled": {
            "pages": len(clean),
            "scores": len({p["score"] for p in clean}),
            "acceptedVocalBoxes": pooled["acceptedVocalBoxes"],
            "matchedShare": pooled["matchedShare"],
        },
        "limits": [
            "Pool membership is an upper bound: OCR-first output may have yielded no mask for a pool score.",
            "Matched share measures agreement with OCR-first labels, which are also the training labels.",
            "OSSQ scores were not in the scan-mask pool; their appearance in the synthetic bank is unverified.",
        ],
    }
    args.out.write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report["cleanPooled"]))


if __name__ == "__main__":
    main()
