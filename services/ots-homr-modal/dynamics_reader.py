"""Read the pinned e4 detector's Dynamic boxes with a small closed-set classifier (p, mf, ff, sfz, ...).

OCR reads p and pp but misses f, ff and mf, so the page's Dynamic boxes are cropped and classified; a box that is not
a mark is rejected by a `none` class that the fine-tune on real detector false positives taught (88% of predicted marks
right on held-out pages, 24 native dynamics; development evidence). Marks are review candidates only: nothing here
writes to a score. Weights: `models/dynamics-ft-real-v1.pth`, trained in homr `training/ocr`.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Sequence

WEIGHTS = Path(__file__).resolve().parent / "models" / "dynamics-ft-real-v1.pth"
WEIGHTS_SHA256 = "2c42456bbe49828149eac8944c0e99d33363b0a02b1a1e389b4acaacd1bd570a"
IMAGE_SIZE = 48
MARGIN = 4
MIN_AREA = 100
MIN_PROBABILITY = 0.5
MAX_BOXES = 800
NMS_IOU = 0.3


def build_model(num_classes: int) -> Any:
    from torch import nn

    class DynamicsCNN(nn.Module):
        """The homr `training/architecture/ocr/dynamics_classifier.py` network, kept in step by its weights' layout."""

        def __init__(self) -> None:
            super().__init__()
            self.features = nn.Sequential(
                nn.Conv2d(1, 16, 3, padding=1), nn.BatchNorm2d(16), nn.ReLU(), nn.MaxPool2d(2, 2),
                nn.Conv2d(16, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(), nn.MaxPool2d(2, 2),
                nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(), nn.MaxPool2d(2, 2),
            )
            self.pool = nn.AdaptiveAvgPool2d((1, 1))
            self.classify = nn.Linear(64, num_classes)

        def forward(self, images: Any) -> Any:
            return self.classify(self.pool(self.features(images)).flatten(1))

    return DynamicsCNN()


def iou(a: Sequence[int], b: Sequence[int]) -> float:
    left, top, right, bottom = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, right - left) * max(0, bottom - top)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class DynamicsReader:
    def __init__(self, weights: Path = WEIGHTS, sha256: str | None = WEIGHTS_SHA256) -> None:
        import torch

        if sha256 is not None and hashlib.sha256(weights.read_bytes()).hexdigest() != sha256:
            raise RuntimeError("Dynamics classifier weights differ from the pinned identity")
        checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
        self.labels: list[str] = list(checkpoint["labels"])
        self.model = build_model(len(self.labels))
        self.model.load_state_dict(checkpoint["model"])
        self.model.eval()

    def read(self, page_bgr: Any, boxes: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        """Dynamic-mark rows for the detector's Dynamic boxes; non-maximum suppressed, strongest first."""
        import cv2
        import numpy as np
        import torch

        gray = cv2.cvtColor(page_bgr, cv2.COLOR_BGR2GRAY) if page_bgr.ndim == 3 else page_bgr
        crops, kept = [], []
        for box in boxes:
            if box.get("label") != "Dynamic":
                continue
            left, top, right, bottom = (int(box[k]) for k in ("left", "top", "right", "bottom"))
            if (right - left) * (bottom - top) < MIN_AREA:
                continue
            crop = gray[max(0, top - MARGIN) : bottom + MARGIN, max(0, left - MARGIN) : right + MARGIN]
            if min(crop.shape) < 4:
                continue
            crops.append(cv2.resize(crop, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0)
            kept.append([left, top, right, bottom])
            if len(kept) >= MAX_BOXES:
                break
        if not crops:
            return []
        with torch.no_grad():
            probabilities = torch.softmax(self.model(torch.from_numpy(np.stack(crops))[:, None]), dim=-1).numpy()
        candidates = []
        for box, probability in zip(kept, probabilities):
            best = int(probability.argmax())
            if self.labels[best] != "none" and float(probability[best]) >= MIN_PROBABILITY:
                candidates.append((float(probability[best]), box, self.labels[best]))
        candidates.sort(key=lambda c: -c[0])
        rows: list[dict[str, Any]] = []
        for probability, box, mark in candidates:
            if any(iou(box, row["box"]) >= NMS_IOU for row in rows):
                continue
            rows.append(
                {
                    "box": box,
                    "text": mark,
                    "ocrConfidence": probability,
                    "semantic": "DirectionText",
                    "semanticScore": None,
                    "proposedLyric": False,
                    "kind": "dynamic",
                    "mark": mark,
                    "source": "classifier",
                }
            )
        return rows
