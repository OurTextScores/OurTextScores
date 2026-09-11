"""Loading and enforcing a pinned text-fusion calibration manifest.

Design: `docs/private/SCANNER_OTS_HOMR_TEXT_FUSION_DESIGN_2026-09-10.md`.

The manifest is the policy: which detector, at which revision and SHA, what it may
contribute, how its raw scores become probabilities, and where the accept line sits. The
design's requirement is that the provider *refuses* readiness when any model identity
differs from it, so identity checking is the point of this module rather than a
convenience on top of it.

Free of the web stack, of torch and of homr, for the same reason `fusion_policy` is: a
policy that decides what reaches a score should be testable without a GPU.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "ots.text-fusion-calibration.v1"


class CalibrationManifestError(RuntimeError):
    """The manifest is unusable, or the running models are not the ones it pins."""


@dataclass(frozen=True)
class DetectorIdentity:
    """What a detector must be for this manifest to apply to it."""

    repository: str
    revision: str
    artifact: str
    sha256: str


@dataclass(frozen=True)
class CalibrationManifest:
    policy: str
    policy_revision: str
    detectors: dict[str, DetectorIdentity]
    class_allowlist: dict[str, frozenset[str]]
    calibration: dict[str, dict[str, Any]]
    accept: dict[str, dict[str, float | None]]
    iou_threshold: float
    containment_threshold: float
    minimum_winner_margin: float

    def calibrate(self, detector_id: str, label: str, raw_confidence: float) -> float | None:
        """Raw confidence to an estimated probability, or None where none is defined.

        None is the answer for a class the manifest deliberately leaves uncalibrated --
        `Dynamic` here -- and `resolve_component` already refuses to let an uncalibrated
        candidate win. Returning a number for it would quietly make it eligible.
        """
        spec = self.calibration.get(detector_id, {}).get(label)
        if not spec:
            return None
        edges: list[float] = spec["binLowerEdges"]
        values: list[float] = spec["binValues"]
        chosen = spec.get("belowLowestEdge")
        for edge, value in zip(edges, values):
            # Bins are half-open and ascending, so the last edge at or below the score
            # wins; anything above the top edge stays in the top bin.
            if raw_confidence >= edge:
                chosen = value
        return chosen

    def accept_threshold(self, detector_id: str) -> Any:
        """A `resolve_component`-shaped lookup: label -> threshold or None."""
        table = self.accept.get(detector_id, {})
        return lambda label: table.get(label)

    def assert_detector_matches(self, detector_id: str, *, sha256: str, revision: str | None = None) -> None:
        """Refuse when the running artifact is not the one this manifest calibrated.

        The numbers in a manifest describe one exact file. Applying them to a different
        one is not a smaller claim, it is an unfounded one -- and the failure would be
        silent, because a different detector still returns boxes with confidences that
        look exactly like the calibrated ones.
        """
        identity = self.detectors.get(detector_id)
        if identity is None:
            raise CalibrationManifestError(
                f"{self.policy} does not calibrate detector {detector_id!r}"
            )
        if sha256.lower() != identity.sha256.lower():
            raise CalibrationManifestError(
                f"{detector_id} artifact sha256 {sha256} is not the calibrated "
                f"{identity.sha256}; refusing {self.policy}"
            )
        if revision is not None and revision != identity.revision:
            raise CalibrationManifestError(
                f"{detector_id} revision {revision} is not the calibrated "
                f"{identity.revision}; refusing {self.policy}"
            )


def load_calibration_manifest(path: str | Path) -> CalibrationManifest:
    raw = Path(path).read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CalibrationManifestError(f"manifest is not JSON: {error}") from error

    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise CalibrationManifestError(
            f"manifest schemaVersion {data.get('schemaVersion')!r} is not {SCHEMA_VERSION!r}"
        )

    stated = data.get("policyRevision")
    if not stated:
        raise CalibrationManifestError("manifest has no policyRevision")
    # The revision is the digest of the manifest without it, so an edited manifest stops
    # matching its own name. Without this the revision is a label a careless edit keeps.
    body = {key: value for key, value in data.items() if key != "policyRevision"}
    computed = hashlib.sha256(
        json.dumps(body, indent=1, sort_keys=True).encode()
    ).hexdigest()
    if computed != stated:
        raise CalibrationManifestError(
            f"manifest policyRevision {stated} does not match its contents ({computed}); "
            "it has been edited since it was pinned"
        )

    detectors: dict[str, DetectorIdentity] = {}
    allowlist: dict[str, frozenset[str]] = {}
    for detector_id, spec in (data.get("detectors") or {}).items():
        for field in ("repository", "revision", "artifact", "sha256"):
            if not spec.get(field):
                raise CalibrationManifestError(f"{detector_id} manifest entry lacks {field}")
        detectors[detector_id] = DetectorIdentity(
            repository=spec["repository"],
            revision=spec["revision"],
            artifact=spec["artifact"],
            sha256=spec["sha256"],
        )
        allowlist[detector_id] = frozenset(spec.get("classAllowlist") or ())
    if not detectors:
        raise CalibrationManifestError("manifest pins no detectors")

    geometry = data.get("geometry") or {}
    return CalibrationManifest(
        policy=data["policy"],
        policy_revision=stated,
        detectors=detectors,
        class_allowlist=allowlist,
        calibration=data.get("calibration") or {},
        accept=data.get("accept") or {},
        iou_threshold=float(geometry.get("iouThreshold", 0.3)),
        containment_threshold=float(geometry.get("containmentThreshold", 0.6)),
        minimum_winner_margin=float(data.get("minimumWinnerMargin", 0.0)),
    )
