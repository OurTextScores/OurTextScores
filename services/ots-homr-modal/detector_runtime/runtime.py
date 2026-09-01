"""Pinned, inference-only loader for the E2/E4 page text detectors."""

from __future__ import annotations

import hashlib
import tempfile
from dataclasses import asdict
from pathlib import Path

import cv2
import torch

from .camvid_model import CamVidModel
from .detector_inference import NUM_CLASSES, boxes_from_probs, predict_mask


class DetectorLoadError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class TextDetector:
    """Loads one immutable checkpoint and predicts page-coordinate boxes."""

    def __init__(
        self,
        *,
        detector_id: str,
        checkpoint: Path,
        revision: str,
        sha256: str,
        device: str,
    ) -> None:
        if detector_id not in {"lyrics", "non-lyric-text"}:
            raise DetectorLoadError("Unsupported text detector")
        if sha256_file(checkpoint) != sha256:
            raise DetectorLoadError("Text detector does not match its pinned SHA-256")
        self.detector_id, self.revision, self.sha256, self.device = (
            detector_id,
            revision,
            sha256,
            device,
        )
        model = CamVidModel(
            arch="Unet",
            encoder_name="resnet18",
            in_channels=3,
            out_classes=NUM_CLASSES,
            skip_weights_download=True,
        )
        state = torch.load(checkpoint, map_location=device, weights_only=True)
        model.load_state_dict(state, strict=True)
        self.model = model.to(device).eval()

    def detect(self, page: bytes, *, batch_size: int = 16) -> list[dict[str, object]]:
        with tempfile.NamedTemporaryFile(suffix=".png") as handle:
            handle.write(page)
            handle.flush()
            image = cv2.imread(handle.name)
        if image is None:
            raise DetectorLoadError("Page image could not be decoded")
        probs = predict_mask(self.model, image, self.device, batch_size=batch_size)
        return [asdict(box) for box in boxes_from_probs(probs)]
