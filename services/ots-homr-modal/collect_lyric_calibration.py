"""Run only the pinned e2 lyric detector on selected pages and record match evidence.

Evidence per box: raw confidence, area, the fraction of the box covered by known Lyrics positives
(`knownCoverage`), best IoU with one, and `verifiedNegative` on instrumental OSSQ pages. Unmatched
boxes on vocal pages stay unknown; nothing is fitted here. Sharded and resumable.
"""

import argparse
import hashlib
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from collect_fusion_calibration import iou
from detector_runtime.runtime import TextDetector
from pins import DETECTORS
from prepare_fusion_calibration import pixel_identity, sha


def coverage(box, truths):
    """Fraction of `box` covered by the union of truth rectangles (exact, via x-slabs)."""
    x0, y0, x1, y1 = box
    clipped = []
    for t in truths:
        q = max(x0, t[0]), max(y0, t[1]), min(x1, t[2]), min(y1, t[3])
        if q[2] > q[0] and q[3] > q[1]:
            clipped.append(q)
    area = (x1 - x0) * (y1 - y0)
    if not clipped or area <= 0:
        return 0.0
    covered = 0
    xs = sorted({x for q in clipped for x in (q[0], q[2])})
    for left, right in zip(xs, xs[1:]):
        spans = sorted((q[1], q[3]) for q in clipped if q[0] <= left and q[2] >= right)
        top = bottom = None
        for a, b in spans:
            if top is None:
                top, bottom = a, b
            elif a <= bottom:
                bottom = max(bottom, b)
            else:
                covered += (right - left) * (bottom - top)
                top, bottom = a, b
        if top is not None:
            covered += (right - left) * (bottom - top)
    return covered / area


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    repo, revision, artifact, digest = DETECTORS["lyrics"]
    detector = TextDetector(
        detector_id="lyrics",
        checkpoint=args.models_root / repo.replace("/", "--") / artifact,
        revision=revision,
        sha256=digest,
        device="cpu",
    )
    rows = [json.loads(line) for line in args.pages.open()]
    mine = [row for index, row in enumerate(rows) if index % args.shards == args.shard]
    args.out.mkdir(parents=True, exist_ok=True)
    results = args.out / f"detections-{args.shard}.jsonl"
    done = set()
    if results.exists():
        for line in results.read_text().splitlines():
            try:
                done.add(json.loads(line)["id"])
            except json.JSONDecodeError:
                break  # truncated final write; the page is redone below
    with results.open("a") as handle:
        for page in mine:
            if page["id"] in done:
                continue
            if sha(page["image"]) != page["image_sha256"] or pixel_identity(Path(page["image"]))[0] != page["pixel_sha256"]:
                raise ValueError("Original input image changed")
            tick = time.monotonic()
            content = Path(page["image"]).read_bytes()
            decoded = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
            if decoded is None:
                raise ValueError("Image could not be decoded")
            truths = [g["box"] for g in page["ground_truth"] if g["semanticFamily"] == "Lyrics"]
            negative = "Lyrics" in page["complete_semantic_families"]
            boxes = []
            for row in detector.detect(content, batch_size=2):
                if row["label"] != "Lyrics":
                    continue
                geometry = [row[k] for k in ("left", "top", "right", "bottom")]
                boxes.append(
                    {
                        "box": geometry,
                        "rawConfidence": row["confidence"],
                        "area": (geometry[2] - geometry[0]) * (geometry[3] - geometry[1]),
                        "knownCoverage": coverage(geometry, truths),
                        "bestKnownIoU": max((iou(geometry, t) for t in truths), default=0.0),
                        "verifiedNegative": negative,
                    }
                )
            handle.write(
                json.dumps(
                    {
                        "id": page["id"],
                        "score": page["score"],
                        "corpus": page["corpus"],
                        "image": page["image"],
                        "image_sha256": page["image_sha256"],
                        "pixel_sha256": page["pixel_sha256"],
                        "knownLyricBoxes": len(truths),
                        "seconds": time.monotonic() - tick,
                        "boxes": boxes,
                    }
                )
                + "\n"
            )
            handle.flush()
            print(f"shard {args.shard} {len(done) + 1}/{len(mine)} {page['score']} {len(boxes)} boxes", flush=True)
            done.add(page["id"])
    (args.out / f"COMPLETE-{args.shard}").write_text("collected; nothing fitted\n")


if __name__ == "__main__":
    main()
