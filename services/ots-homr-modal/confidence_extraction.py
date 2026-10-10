"""Identity of the code that turns detector output into the raw confidences a calibration is fitted on.

A calibration manifest maps raw confidences to probabilities, so it describes the extraction that produced those
confidences as much as the model weights. Weights alone are not enough: the 2026-10-08 fix that averages a box's
confidence over its own component's pixels (not every same-class pixel inside its bounding rectangle) changed 57 of
337 box scores on one real page without touching a weight. This module hashes the shipped extraction source so a
manifest can bind it and the provider can refuse a manifest fitted on different semantics.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

#: Bump when the semantics change on purpose (the hash catches accidental edits; the id names the intent).
EXTRACTION_ID = "component-pixels-v2"
RUNTIME_DIR = Path(__file__).resolve().parent / "detector_runtime"
#: Everything between the checkpoint and a box's confidence: tiling and mask prediction, component boxes and their
#: scoring, patch extraction, class order and the runtime wrapper.
EXTRACTION_FILES = (
    "camvid_model.py",
    "detector_data.py",
    "detector_inference.py",
    "detector_masks.py",
    "detector_patches.py",
    "runtime.py",
)


def confidence_extraction_identity() -> dict[str, Any]:
    digest = hashlib.sha256()
    for name in sorted(EXTRACTION_FILES):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256((RUNTIME_DIR / name).read_bytes()).hexdigest().encode("ascii"))
        digest.update(b"\n")
    return {"id": EXTRACTION_ID, "files": list(sorted(EXTRACTION_FILES)), "sourceSha256": digest.hexdigest()}


if __name__ == "__main__":
    import json

    print(json.dumps(confidence_extraction_identity(), indent=2))
