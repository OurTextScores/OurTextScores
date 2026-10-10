"""Identity of everything that turns a page into review rows, so a scanner can pin it like it pins the detectors.

The detectors and calibration were already pinned. The review path adds more that changes what a reviewer sees: the OCR
library and its models, the semantic gate, the dynamics classifier and its thresholds, and the code that selects and
filters rows. `review_text_identity()` lists each by hash (models by the SHA-256 their loaders verify at start, code by
the bytes of the shipped modules) and `identity_sha256` rolls the whole into one digest the scanner can require. The
scanner recomputes the digest from the reported details, so a provider cannot claim a digest its details do not give.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

SCHEMA = "ots.review-text-identity.v1"
HERE = Path(__file__).resolve().parent
#: Modules whose behaviour decides which rows a reviewer is offered (hashed by file bytes).
CODE_MODULES = (
    "calibration_manifest.py",
    "detector_routes.py",
    "direction_text.py",
    "dynamics_reader.py",
    "fusion_policy.py",
    "fusion_v1.py",
    "lyric_ocr.py",
    "ots_engine.py",
    "review_identity.py",
    "semantic_gate.py",
)


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, ASCII: the same bytes in Python and in the scanner's TypeScript."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def identity_sha256(identity: dict[str, Any]) -> str:
    body = {key: value for key, value in identity.items() if key != "sha256"}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def _file_sha256(name: str) -> str:
    return hashlib.sha256((HERE / name).read_bytes()).hexdigest()


def review_text_identity() -> dict[str, Any]:
    """Identity of the review pipeline as shipped. Models are the pinned values their loaders verify at start."""
    import direction_text
    import dynamics_reader
    import lyric_ocr
    import semantic_gate

    identity: dict[str, Any] = {
        "schemaVersion": SCHEMA,
        "ocr": {
            "library": "rapidocr",
            "version": lyric_ocr.RAPIDOCR_VERSION,
            "modelSha256": {role: digest for role, (_, digest) in sorted(lyric_ocr.MODEL_SHA256.items())},
            "minRegionArea": lyric_ocr.MIN_REGION_AREA,
            "minCoverage": lyric_ocr.MIN_COVERAGE,
            "maxRows": lyric_ocr.MAX_ROWS,
        },
        "semanticGate": {"modelSha256": semantic_gate.MODEL_SHA256},
        "directionRows": {
            "maxRows": direction_text.MAX_DIRECTION_ROWS,
            "minWordLetters": direction_text.MIN_WORD_LETTERS,
            "termCount": len(direction_text.TERMS),
        },
        "dynamicsClassifier": {
            "weightsSha256": dynamics_reader.WEIGHTS_SHA256,
            "minProbability": dynamics_reader.MIN_PROBABILITY,
            "minMarkArea": dynamics_reader.MIN_MARK_AREA,
            "maxMarkArea": dynamics_reader.MAX_MARK_AREA,
            "skipMarks": sorted(dynamics_reader.SKIP_MARKS),
        },
        "codeSha256": {name: _file_sha256(name) for name in CODE_MODULES},
    }
    identity["sha256"] = identity_sha256(identity)
    return identity


if __name__ == "__main__":
    print(json.dumps(review_text_identity(), indent=2, sort_keys=True))
