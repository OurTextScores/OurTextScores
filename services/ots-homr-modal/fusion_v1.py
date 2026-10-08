"""Pinned, fail-closed fusion of three logical page-text detector outputs.

This produces box decisions for review. It does not attach text to MusicXML:
recognition and attachment have separate release gates in the fusion design.
"""

from __future__ import annotations

import hashlib
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from calibration_manifest import CalibrationManifest
from pins import FUSION_DETECTORS, DETECTOR_ROUTES
from fusion_policy import (
    CLASS_ALLOWLIST,
    SEMANTIC_FAMILY,
    DetectorCandidate,
    FusionPolicyError,
    conflict_components,
    gate,
)

REQUIRED_DETECTORS = FUSION_DETECTORS

#: Review regions listed per page. Uncalibrated e4 output can produce hundreds that no person can
#: review and that would exceed the provider's response cap; the rest are counted, not listed.
MAX_LISTED_REVIEW_REGIONS = 200


@dataclass(frozen=True)
class FusionResult:
    regions: list[dict[str, Any]]
    summary: dict[str, Any]


def _candidate_id(
    page_sha256: str, detector_id: str, revision: str, label: str, box: tuple[int, ...]
) -> str:
    source = f"{page_sha256}:{detector_id}:{revision}:{label}:{','.join(map(str, box))}"
    return hashlib.sha256(source.encode()).hexdigest()[:24]


def fuse_page(
    *,
    page_sha256: str,
    page_size: tuple[int, int],
    detections: Mapping[str, Sequence[Mapping[str, Any]]],
    detector_identities: Mapping[str, tuple[str, str]],
    manifest: CalibrationManifest,
) -> FusionResult:
    """Fuse three completed logical routes; empty is valid, absent is not.

    ``detections`` must contain every logical key even for an empty page. Each
    identity is ``(revision, sha256)`` and must match the immutable calibration.
    """
    if manifest.policy != "fusion-v1":
        raise FusionPolicyError("fusion-v1 requires its own calibration manifest")
    if set(detections) != set(REQUIRED_DETECTORS):
        raise FusionPolicyError("all three logical detector runs are required for fusion-v1")
    if set(detector_identities) != set(REQUIRED_DETECTORS):
        raise FusionPolicyError("all three logical detector identities are required for fusion-v1")
    if set(manifest.detectors) != set(REQUIRED_DETECTORS):
        raise FusionPolicyError("fusion-v1 calibration must identify exactly three logical routes")
    for detector_id in REQUIRED_DETECTORS:
        revision, digest = detector_identities[detector_id]
        manifest.assert_detector_matches(detector_id, revision=revision, sha256=digest)
        if manifest.class_allowlist.get(detector_id) != CLASS_ALLOWLIST[detector_id]:
            raise FusionPolicyError(f"{detector_id} calibration allowlist differs from runtime")

    raw_candidates: list[DetectorCandidate] = []
    seen_ids: set[str] = set()
    for detector_id in REQUIRED_DETECTORS:
        revision, _ = detector_identities[detector_id]
        for raw in detections[detector_id]:
            try:
                label = str(raw["label"])
                coordinates = tuple(raw[field] for field in ("left", "top", "right", "bottom"))
                if any(type(value) is not int for value in coordinates):
                    raise ValueError("box coordinates must be integers")
                box = coordinates
                confidence = float(raw["confidence"])
            except (KeyError, TypeError, ValueError) as error:
                raise FusionPolicyError(f"{detector_id} returned a malformed box") from error
            if not 0.0 <= confidence <= 1.0:
                raise FusionPolicyError(f"{detector_id} returned invalid confidence")
            candidate_id = _candidate_id(page_sha256, detector_id, revision, label, box)
            if candidate_id in seen_ids:
                raise FusionPolicyError(f"{detector_id} returned duplicate boxes")
            seen_ids.add(candidate_id)
            calibrated = manifest.calibrate(detector_id, label, confidence)
            if calibrated is not None and (
                not math.isfinite(calibrated) or not 0.0 <= calibrated <= 1.0
            ):
                raise FusionPolicyError("fusion-v1 calibration returned an invalid probability")
            raw_candidates.append(
                DetectorCandidate(
                    candidate_id=candidate_id,
                    detector_id=detector_id,
                    label=label,
                    box=box,  # type: ignore[arg-type]
                    raw_confidence=confidence,
                    calibrated_confidence=calibrated,
                )
            )

    candidates, rejected = gate(
        raw_candidates,
        page_size,
        min_box_area=manifest.min_box_area,
        max_page_area_fraction=manifest.max_page_area_fraction,
    )
    candidates.sort(key=lambda c: (c.detector_id, c.label, c.box, c.candidate_id))
    regions: list[dict[str, Any]] = []
    tally: Counter[str] = Counter()
    by_class: Counter[str] = Counter()
    for component in conflict_components(
        candidates,
        iou_threshold=manifest.iou_threshold,
        containment_threshold=manifest.containment_threshold,
    ):
        members = [candidates[index] for index in component]
        ranked = sorted(
            members,
            key=lambda c: (
                -(c.calibrated_confidence if c.calibrated_confidence is not None else -1),
                c.candidate_id,
            ),
        )
        winner = ranked[0]
        score = winner.calibrated_confidence
        threshold = manifest.accept_threshold(winner.detector_id)(winner.label)
        reason = "independent" if len(members) == 1 else "calibrated-winner"
        # Uncalibrated competing evidence cannot be safely outscored. Dynamics
        # are review-only even if a future manifest assigns them probabilities.
        if winner.label == "Dynamic":
            reason = "dynamic-review-only"
        elif score is None or threshold is None or score < threshold:
            reason = "below-threshold"
        elif len(members) > 1 and any(c.calibrated_confidence is None for c in members):
            reason = "uncalibrated-conflict"
        elif (
            len(members) > 1
            and score - (ranked[1].calibrated_confidence or 0)
            < manifest.minimum_winner_margin
        ):
            reason = "insufficient-margin"
        elif len(members) > 1 and score == ranked[1].calibrated_confidence:
            reason = "insufficient-margin"
        status = "accepted" if reason in {"independent", "calibrated-winner"} else "review"
        tally[status] += 1
        if status == "accepted":
            by_class[winner.label] += 1
        regions.append(
            {
                "status": status,
                "reason": reason,
                "selectedCandidateId": winner.candidate_id if status == "accepted" else None,
                "candidates": [
                    {
                        "id": candidate.candidate_id,
                        "detectorId": candidate.detector_id,
                        "physicalDetectorId": DETECTOR_ROUTES[candidate.detector_id],
                        "label": candidate.label,
                        "semanticFamily": SEMANTIC_FAMILY.get(candidate.label),
                        "box": list(candidate.box),
                        "rawConfidence": candidate.raw_confidence,
                        "calibratedConfidence": candidate.calibrated_confidence,
                    }
                    for candidate in members
                ],
            }
        )
    # Keep the review list reviewable: regions holding a calibrated candidate first (any lyric
    # decision that was close), then the strongest raw evidence. Accepted regions are always kept.
    review = [r for r in regions if r["status"] == "review"]
    review.sort(
        key=lambda r: (
            not any(c["calibratedConfidence"] is not None for c in r["candidates"]),
            -max(c["rawConfidence"] for c in r["candidates"]),
            r["candidates"][0]["id"],
        )
    )
    listed = {id(r) for r in review[:MAX_LISTED_REVIEW_REGIONS]}
    review_omitted = len(review) - len(listed)
    regions = [r for r in regions if r["status"] != "review" or id(r) in listed]
    # Rejected candidates are tallied, never listed. A real page yields hundreds (e4 alone
    # emits ~450 Fingering and ~450 MeasureNumber boxes), which would exceed the response cap
    # and bury the review work; the reason counts keep every drop accountable.
    rejected_by_reason: Counter[str] = Counter(reason for _, reason in rejected)
    rejected_by_class: Counter[str] = Counter(candidate.label for candidate, _ in rejected)
    return FusionResult(
        regions=regions,
        summary={
            "accepted": tally["accepted"],
            "review": tally["review"],
            "reviewOmitted": review_omitted,
            "rejected": len(rejected),
            "rejectedByReason": dict(sorted(rejected_by_reason.items())),
            "rejectedByClass": dict(sorted(rejected_by_class.items())),
            "byClass": dict(sorted(by_class.items())),
        },
    )
