"""Proof of concept (review-only): direction-text and dynamics candidates on the judged Lieder pages.

Direction boxes come from the 2026-09-19 adaptation parent (five-class DirectionText model, 19/22 recall on
Lieder box pages, ~15-20% precision lower bound); dynamics boxes are the pinned e4's Dynamic channel, reused
from the frozen CPU replay. Each box is read by full-page RapidOCR and labelled by the semantic gate. Nothing
here is wired into the scanner; the output is a development measurement for the owner to judge.
"""

import argparse
import json
import sys
import time
from pathlib import Path

HOMR = Path("/home/jhlusko/workspace/homr")
WEIGHTS = Path(
    "/home/jhlusko/workspace/homr-artifacts/gpu-roadmap-20260919/instance-results/workspace/"
    "retrain-direction-20260919/weights/sampler-0.14-s42/epoch-4.pth"
)
# Lowercase tokens whose presence marks a written direction or dynamic; judged by the owner, not trusted.
DYNAMIC_MARKS = {"p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "rf", "rfz", "cresc.", "dim."}


def coverage(inner, outer):
    left, top = max(inner[0], outer[0]), max(inner[1], outer[1])
    right, bottom = min(inner[2], outer[2]), min(inner[3], outer[3])
    area = max(0, right - left) * max(0, bottom - top)
    return area / max(1, (inner[2] - inner[0]) * (inner[3] - inner[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--e4", type=Path, required=True, help="frozen replay pages.jsonl with e4 raw detections")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(HOMR))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import cv2
    import torch
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate
    from training.ocr.detector_inference import load_model, predict_boxes

    torch.set_num_threads(4)
    pages = [p for p in json.loads(args.pages.read_text()) if p["corpus"] == "lieder"]
    e4 = {}
    for line in args.e4.read_text().splitlines():
        row = json.loads(line)
        e4[row["id"]] = row
    model = load_model(WEIGHTS, "cpu")
    pipeline = LyricTextPipeline(SemanticGate.load(), threads=4)
    args.out.mkdir(parents=True, exist_ok=True)
    result = args.out / "pages.jsonl"
    done = {json.loads(line)["id"] for line in result.read_text().splitlines()} if result.exists() else set()
    with result.open("a") as handle:
        for page in pages:
            if page["id"] in done:
                continue
            start = time.monotonic()
            image = cv2.imread(page["image"])
            direction = [
                b.__dict__ for b in predict_boxes(model, Path(page["image"]), "cpu", batch_size=2)
                if b.label == "DirectionText"
            ]
            detections = e4[page["id"]]["rawDetections"]
            dynamics = [
                d for name in ("non-lyric-text", "dynamics") for d in detections.get(name, []) if d["label"] == "Dynamic"
            ]
            rows = pipeline.read_page(image)
            for row in rows:
                xs, ys = [p[0] for p in row["box"]], [p[1] for p in row["box"]]
                row["rect"] = [min(xs), min(ys), max(xs), max(ys)]
                row["semantic"] = pipeline.gate.classify(row["text"])
            record = {
                "id": page["id"],
                "score": page["score"],
                "image": page["image"],
                "directionBoxes": direction,
                "dynamicBoxes": [{k: d[k] for k in ("left", "top", "right", "bottom", "confidence")} for d in dynamics],
                "ocrRows": rows,
                "seconds": time.monotonic() - start,
            }
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            print(f"{page['score']}: direction={len(direction)} dynamic={len(dynamics)} ocrRows={len(rows)} {record['seconds']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
