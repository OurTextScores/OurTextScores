"""Label real e4 Dynamic boxes from the native OpenScore score, for fine-tuning the dynamics classifier.

For each scanned page that aligns to its native song (per-measure pitch similarity, as in score_direction_placement):
- a box in a measure whose neighbours (m-1, m, m+1) hold no native dynamic is a hard NEGATIVE ("none"): it is what
  the detector over-predicts (notes, text, clutter);
- in a measure with native dynamics, each distinct native mark takes the ONE box of that measure that the current
  classifier finds most like that mark (probability >= MIN_P), as a POSITIVE with the native label. The mark is
  known from the score; only the choice among the measure's boxes uses the model.
Boxes in other measures with native dynamics stay unlabeled. Split is by score.
"""

import argparse
import collections
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, "/home/jhlusko/workspace/OurTextScores/services/ots-homr-modal")
HOMR = "/home/jhlusko/workspace/homr"
MIN_P = float(__import__("os").environ.get("MIN_P", "0.10"))
MIN_AREA = 100
MIN_ALIGNMENT = 0.9


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--job-data", type=Path, required=True)
    parser.add_argument("--rasters", type=Path, required=True)
    parser.add_argument("--anchored", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--valid-share", type=float, default=0.2)
    args = parser.parse_args()
    sys.path.insert(0, HOMR)
    import xml.etree.ElementTree as ET

    import yaml
    from score_direction_placement import SOURCES, align, native_candidates, parse_parts
    from training.architecture.ocr.dynamics_classifier import IMAGE_SIZE, DynamicsCNN

    checkpoint = torch.load(args.weights, map_location="cpu", weights_only=True)
    labels = checkpoint["labels"]
    model = DynamicsCNN(len(labels))
    model.load_state_dict(checkpoint["model"])
    model.eval()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    anchored = json.loads(args.anchored.read_text())
    (args.out / "crops").mkdir(parents=True, exist_ok=True)
    rows, report = [], []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        score, job_id = Path(job["image"]).parent.name, job["jobId"]
        if job_id not in anchored:
            report.append({"score": score, "status": "no e4 boxes"})
            continue
        page_parts = parse_parts(ET.fromstring((args.job_data / f"{job_id}.musicxml").read_bytes()))
        best = None
        for _, native_root in native_candidates(score, catalogue):
            native_parts = parse_parts(native_root)
            start, quality = align(page_parts[0], native_parts[0])
            if best is None or quality > best[0]:
                best = (quality, start, native_parts)
        if best is None or best[0] < MIN_ALIGNMENT:
            report.append({"score": score, "status": f"not aligned ({best[0] if best else 0:.2f})"})
            continue
        _, start, native_parts = best
        window = len(page_parts[0])
        marks = collections.defaultdict(list)  # page measure -> native dynamic marks (any part)
        for measures in native_parts[: len(page_parts)]:
            for offset in range(window):
                if start + offset < len(measures):
                    marks[offset + 1] += [d["text"] for d in measures[start + offset]["directions"] if d["kind"] == "dynamic"]
        raster = cv2.imread(str(args.rasters / f"{job_id}.png"), cv2.IMREAD_GRAYSCALE)
        boxes = []
        for box in anchored[job_id]:
            if box["measure"] is None or (box["right"] - box["left"]) * (box["bottom"] - box["top"]) < MIN_AREA:
                continue
            crop = raster[max(0, box["top"] - 4) : box["bottom"] + 4, max(0, box["left"] - 4) : box["right"] + 4]
            if min(crop.shape) < 4:
                continue
            tensor = torch.from_numpy(cv2.resize(crop, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0)[None, None]
            with torch.no_grad():
                probability = torch.softmax(model(tensor), dim=-1)[0].numpy()
            boxes.append({"crop": crop, "measure": box["measure"], "p": probability})
        taken, positives, negatives = set(), 0, 0
        for measure in sorted({b["measure"] for b in boxes}):
            here = [i for i, b in enumerate(boxes) if b["measure"] == measure]
            if not any(marks.get(m) for m in (measure - 1, measure, measure + 1)):
                for i in here:
                    taken.add((i, "none"))
                    negatives += 1
                continue
            for mark in sorted(set(marks.get(measure, []))):
                if mark not in labels:
                    continue
                candidates = sorted((i for i in here if i not in {t[0] for t in taken}), key=lambda i: -boxes[i]["p"][labels.index(mark)])
                for i in candidates[: marks[measure].count(mark)]:
                    if boxes[i]["p"][labels.index(mark)] >= MIN_P:
                        taken.add((i, mark))
                        positives += 1
        for i, label in sorted(taken):
            path = args.out / "crops" / f"{job_id[:8]}-{i}-{label}.png"
            cv2.imwrite(str(path), boxes[i]["crop"])
            rows.append({"image": str(path), "label": label, "score": score})
        report.append({"score": score, "status": "ok", "alignment": round(best[0], 2), "positives": positives, "negatives": negatives, "nativeMarks": sum(len(v) for v in marks.values())})
    scores = sorted({r["score"] for r in rows})
    valid = {s for i, s in enumerate(scores) if i % round(1 / args.valid_share) == 0}
    for split, keep in (("train", lambda r: r["score"] not in valid), ("valid", lambda r: r["score"] in valid)):
        (args.out / f"{split}.jsonl").write_text("\n".join(json.dumps(r) for r in rows if keep(r)) + "\n", encoding="utf-8")
    (args.out / "report.json").write_text(json.dumps(report, indent=1))
    counts = collections.Counter(r["label"] for r in rows)
    print(f"{len(rows)} crops from {len(scores)} aligned pages; labels: {dict(counts.most_common())}")
    print("pages:", collections.Counter(r["status"].split(" (")[0] for r in report))


if __name__ == "__main__":
    main()
