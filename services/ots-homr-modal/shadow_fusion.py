"""What a calibrated policy *would* do to a page, recorded and applied to nothing.

Design: `docs/private/SCANNER_OTS_HOMR_TEXT_FUSION_DESIGN_2026-09-10.md` — "ship shadow
diagnostics with no MusicXML change".

Shadow mode exists because the numbers behind a threshold come from a sample, and a
sample is not a page. The measured 92.3% precision was estimated on 145 unmatched boxes
from 45 vocal pages; running the whole pipeline over real scans and recording every
decision is how that estimate meets pages nobody adjudicated, before anything it decides
can reach a score.

It produces a report and nothing else. That is not a limitation to be lifted later by
adding a write path here: the value of a shadow run is precisely that its output cannot
be confused with a change, so the only honest way to promote is to read these reports and
then wire the accepted candidates in somewhere else.

Every withheld candidate carries why. A count of acceptances says a policy is working;
only the reasons say whether the ones it withheld were the ones it should have.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Sequence

from calibration_manifest import CalibrationManifest
from fusion_policy import (
    DetectorCandidate,
    conflict_components,
    gate,
    resolve_component,
)


@dataclass(frozen=True)
class ShadowDecision:
    """One candidate and what the policy would have done with it."""

    candidate_id: str
    label: str
    box: tuple[int, int, int, int]
    raw_confidence: float
    calibrated_confidence: float | None
    accepted: bool
    reason: str


@dataclass(frozen=True)
class ShadowPageReport:
    page: str
    detector_id: str
    policy: str
    policy_revision: str
    decisions: list[ShadowDecision]
    """Candidates the class allowlist refused, with the reason each was refused."""
    rejected: list[tuple[str, str]] = field(default_factory=list)

    @property
    def accepted(self) -> list[ShadowDecision]:
        return [decision for decision in self.decisions if decision.accepted]

    def counts(self) -> dict[str, int]:
        """Accepted, and the reason for every one that was not."""
        tally = Counter()
        tally["predicted"] = len(self.decisions) + len(self.rejected)
        tally["accepted"] = len(self.accepted)
        for decision in self.decisions:
            if not decision.accepted:
                tally[f"withheld:{decision.reason}"] += 1
        for _, reason in self.rejected:
            tally[f"gated:{reason}"] += 1
        return dict(tally)


def shadow_page(
    *,
    page: str,
    detector_id: str,
    boxes: Sequence[tuple[str, tuple[int, int, int, int], float]],
    manifest: CalibrationManifest,
    page_size: tuple[int, int],
) -> ShadowPageReport:
    """Run gate → calibrate → conflicts → resolve over one page's detector output.

    `boxes` are `(label, box, raw_confidence)` straight from the detector, deliberately
    not `DetectorCandidate`: building those is part of what is being tested, and a caller
    that had already built them could have set `calibrated_confidence` itself, which is
    the one field nothing outside the manifest may decide.
    """
    candidates = [
        DetectorCandidate(
            candidate_id=f"{page}#{index}",
            detector_id=detector_id,
            label=label,
            box=box,
            raw_confidence=confidence,
            calibrated_confidence=manifest.calibrate(detector_id, label, confidence),
        )
        for index, (label, box, confidence) in enumerate(boxes)
    ]

    accepted_candidates, rejected = gate(candidates, page_size)
    components = conflict_components(
        accepted_candidates,
        iou_threshold=manifest.iou_threshold,
        containment_threshold=manifest.containment_threshold,
    )

    decisions: list[ShadowDecision] = []
    for component in components:
        members = [accepted_candidates[index] for index in component]
        winner, reason = resolve_component(
            members,
            accept_threshold=manifest.accept_threshold(detector_id),
            minimum_margin=manifest.minimum_winner_margin,
        )
        for member in members:
            won = winner is not None and member.candidate_id == winner.candidate_id
            decisions.append(
                ShadowDecision(
                    candidate_id=member.candidate_id,
                    label=member.label,
                    box=member.box,
                    raw_confidence=member.raw_confidence,
                    calibrated_confidence=member.calibrated_confidence,
                    accepted=won,
                    # A member of a component that someone else won was not itself below
                    # anything; saying so would misattribute the reason.
                    reason=reason if won or len(members) == 1 else "lost-component",
                )
            )

    return ShadowPageReport(
        page=page,
        detector_id=detector_id,
        policy=manifest.policy,
        policy_revision=manifest.policy_revision,
        decisions=decisions,
        rejected=[(candidate.candidate_id, reason) for candidate, reason in rejected],
    )


def shadow_totals(reports: Sequence[ShadowPageReport]) -> dict[str, int]:
    """Summed counts across pages, for reading a run at a glance."""
    total = Counter()
    for report in reports:
        total.update(report.counts())
    return dict(total)
