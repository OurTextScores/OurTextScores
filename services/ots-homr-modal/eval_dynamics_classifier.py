"""Score a Dynamic-mark classifier on real scanner pages against the native OpenScore source.

Boxes are the pinned e4 detector's Dynamic boxes on each job's recognition raster, anchored to a part and measure
by the scanner's own anchoring (`anchor_boxes.cjs`). A native dynamic counts as found when a predicted mark with the
same label sits in the same measure (neither hands nor parts are told apart: a mark between the voice and piano staves is filed under one part natively, and the scanner may anchor it to the other). The OCR baseline uses the dynamic rows the
scanner offered, matched the same way, so the two are comparable; "combined" is their union.
"""

import argparse
import collections
import json
from pathlib import Path

import cv2
import numpy as np
import torch

HOMR = "/home/jhlusko/workspace/homr"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--anchored", type=Path, required=True)
    parser.add_argument("--rasters", type=Path, required=True)
    parser.add_argument("--truth", type=Path, required=True, help="ground-truth-score.json")
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--min-area", type=int, default=100)
    args = parser.parse_args()
    import sys

    sys.path.insert(0, HOMR)
    from training.architecture.ocr.dynamics_classifier import IMAGE_SIZE, DynamicsCNN

    checkpoint = torch.load(args.weights, map_location="cpu", weights_only=True)
    labels = checkpoint["labels"]
    model = DynamicsCNN(len(labels))
    model.load_state_dict(checkpoint["model"])
    model.eval()
    anchored = json.loads(args.anchored.read_text())
    details = json.loads(args.truth.read_text())["details"]
    job_of = {Path(json.loads(l)["image"]).parent.name: json.loads(l)["jobId"] for l in args.jobs.read_text().splitlines()}
    sweep = [0.5, 0.7, 0.9]
    totals = {t: collections.Counter() for t in sweep}
    ocr_total, native_total, per_mark = collections.Counter(), 0, collections.defaultdict(collections.Counter)
    for page in details:
        job = job_of[page["score"]]
        raster = cv2.imread(str(args.rasters / f"{job}.png"), cv2.IMREAD_GRAYSCALE)
        truth = {(0, t["measure"], t["text"]) for t in page["truth"] if t["kind"] == "dynamic"}
        native_total += len(truth)
        crops, meta = [], []
        for box in anchored[job]:
            width, height = box["right"] - box["left"], box["bottom"] - box["top"]
            if width * height < args.min_area or box["measure"] is None:
                continue
            crop = raster[max(0, box["top"] - 4) : box["bottom"] + 4, max(0, box["left"] - 4) : box["right"] + 4]
            if min(crop.shape) < 4:
                continue
            resized = cv2.resize(crop, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_AREA)
            crops.append(torch.from_numpy(resized.astype(np.float32) / 255.0).unsqueeze(0))
            meta.append((0, box["measure"]))
        with torch.no_grad():
            probabilities = torch.softmax(model(torch.stack(crops)), dim=-1) if crops else torch.zeros(0, len(labels))
        ocr = {(0, r["_measure"], r["text"]) for r in page["rows"] if r["kind"] == "dynamic" and r["_measure"] is not None}
        ocr_found = truth & ocr
        ocr_total["found"] += len(ocr_found)
        for threshold in sweep:
            predicted = set()
            for (part, measure), probability in zip(meta, probabilities):
                best = int(probability.argmax())
                if labels[best] != "none" and float(probability[best]) >= threshold:
                    predicted.add((part, measure, labels[best]))
            found = truth & predicted
            totals[threshold]["found"] += len(found)
            totals[threshold]["predicted"] += len(predicted)
            totals[threshold]["correct_predictions"] += len(predicted & truth)
            totals[threshold]["combined"] += len(truth & (predicted | ocr))
            if threshold == sweep[1]:
                for item in truth:
                    per_mark[item[2]]["native"] += 1
                    per_mark[item[2]]["classifier"] += item in predicted
                    per_mark[item[2]]["ocr"] += item in ocr
    print(f"native dynamics on aligned pages: {native_total}")
    print(f"OCR rows alone found {ocr_total['found']} ({ocr_total['found'] / native_total:.0%})")
    for threshold in sweep:
        c = totals[threshold]
        print(f"classifier p>={threshold}: found {c['found']} ({c['found'] / native_total:.0%}), predicted marks {c['predicted']} of which in native {c['correct_predictions']} ({c['correct_predictions'] / max(1, c['predicted']):.0%}); combined with OCR {c['combined']} ({c['combined'] / native_total:.0%})")
    print("per mark at p>=0.7 (native, classifier, ocr):", {m: (v["native"], v["classifier"], v["ocr"]) for m, v in sorted(per_mark.items())})


if __name__ == "__main__":
    main()
