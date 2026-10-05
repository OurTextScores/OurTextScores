"""Diagnostic component-area sweep; partial labels never become false negatives."""

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path

import cv2
import torch
from collect_fusion_calibration import iou
from detector_routes import route_detections
from detector_runtime.detector_inference import boxes_from_probs, predict_mask
from detector_runtime.runtime import TextDetector
from fusion_policy import CLASS_ALLOWLIST
from pins import DETECTORS
from prepare_fusion_calibration import pixel_identity, sha


def summarize(page, physical):
    routed = route_detections(physical)
    result = {}
    for route, rows in routed.items():
        boxes = [r for r in rows if r["label"] in CLASS_ALLOWLIST[route]]
        family = {
            "lyrics": "Lyrics",
            "dynamics": "Dynamic",
            "non-lyric-text": "DirectionText",
        }[route]
        truths = [g for g in page["ground_truth"] if g["semanticFamily"] == family]
        overlaps = [
            max(
                (
                    iou(g["box"], [b[k] for k in ("left", "top", "right", "bottom")])
                    for b in boxes
                ),
                default=0.0,
            )
            for g in truths
        ]
        result[route] = {
            "candidates": len(boxes),
            "known_positive_count": len(truths),
            "known_positive_hits": {
                str(t): sum(v >= t for v in overlaps) for t in (0.1, 0.3, 0.5)
            },
            "maximum_positive_ious": overlaps,
            "verified_negative_candidates": (
                len(boxes)
                if family in page["complete_semantic_families"] and not truths
                else None
            ),
            "unmatched_policy": "unknown-until-adjudicated",
        }
    return result


def run(pages, models_root, out):
    if out.exists():
        raise ValueError("Output must be new; no mixed run identities")
    out.mkdir(parents=True)
    torch.set_num_threads(1)
    cv2.setNumThreads(1)
    rows = [json.loads(line) for line in pages.open()]
    if any(p["partition"] != "calibration" for p in rows):
        raise ValueError("Sweep must not inspect held-out test pages")
    (out / "identity.json").write_text(
        json.dumps(
            {
                "pages_sha256": sha(pages),
                "script_sha256": sha(__file__),
                "implementations": {
                    n: sha(Path(__file__).parent / n)
                    for n in (
                        "detector_runtime/detector_inference.py",
                        "detector_runtime/runtime.py",
                        "detector_routes.py",
                        "pins.py",
                    )
                },
                "physical_detectors": DETECTORS,
                "torch": str(torch.__version__),
                "opencv": cv2.__version__,
                "device": "cpu",
                "threads": 1,
                "areas": [4, 10, 25, 50, 100, 200],
                "scope": "Calibration-only postprocessing diagnostic; not fitted calibration",
            },
            indent=2,
        )
        + "\n"
    )
    detectors = {
        key: TextDetector(
            detector_id=key,
            checkpoint=models_root / repo.replace("/", "--") / file,
            revision=rev,
            sha256=digest,
            device="cpu",
        )
        for key, (repo, rev, file, digest) in DETECTORS.items()
    }
    with (out / "sweep.jsonl").open("w") as handle:
        for index, page in enumerate(rows):
            if (
                sha(page["image"]) != page["image_sha256"]
                or pixel_identity(Path(page["image"]))[0] != page["pixel_sha256"]
            ):
                raise ValueError("Original page changed")
            started = time.monotonic()
            image = cv2.imread(page["image"])
            physical = {area: {} for area in (4, 10, 25, 50, 100, 200)}
            for key, detector in detectors.items():
                probs = predict_mask(detector.model, image, "cpu", batch_size=2)
                for area, detections in physical.items():
                    detections[key] = [
                        asdict(b) for b in boxes_from_probs(probs, min_area=area)
                    ]
                del probs
            record = {
                "id": page["id"],
                "score": page["score"],
                "corpus": page["corpus"],
                "seconds": time.monotonic() - started,
                "areas": {str(a): summarize(page, p) for a, p in physical.items()},
            }
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            print(
                f'{index+1}/{len(rows)} {page["score"]}: {record["seconds"]:.1f}s',
                flush=True,
            )
    (out / "COMPLETE").write_text(
        "Diagnostic complete; defaults and calibration unchanged.\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args.pages, args.models_root, args.out)
