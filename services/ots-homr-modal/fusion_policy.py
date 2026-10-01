"""Deterministic half of Stage 3 text fusion: gating and conflict geometry.

Design: `docs/private/SCANNER_OTS_HOMR_TEXT_FUSION_DESIGN_2026-09-10.md`.

Everything here is decidable without calibration, so it is built first and tested on its
own: which classes a detector is allowed to contribute, which candidates conflict, and
which conflicts must be resolved together. Calibrated scoring is injected, because the
calibration corpus is the expensive part of this phase and nothing here should wait on
it — or silently invent a threshold in its absence.

Free of the web stack, of torch, and of homr, for the same reason
`score_profile_policy` is: the rules are the part that must be right, and they should be
testable without a GPU.

Two rules are load-bearing and easy to erode later:

- A detector contributes only the classes its loss actually trained. A graph can emit a
  label it was never taught, and preserving such a box turns a known training failure
  into product output.
- Raw detector confidence is a mean pixel probability. It is not comparable across
  checkpoints or classes, so it may never decide a conflict between them. Where no
  calibrated score exists, the conflict is review work rather than a coin toss.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

DetectorId = Literal["lyrics", "non-lyric-text", "dynamics"]

#: What each checkpoint's loss actually trained, per the design's capability table.
#: A logical route has sole ownership of its classes. Dynamic is review-only;
#: the experimental structured dynamics head is never an automatic authority.
CLASS_ALLOWLIST: dict[str, frozenset[str]] = {
    "lyrics": frozenset({"Lyrics"}),
    "non-lyric-text": frozenset({"Tempo", "StaffText", "Expression"}),
    "dynamics": frozenset({"Dynamic"}),
}
SEMANTIC_FAMILY = {
    "Lyrics": "Lyrics", "Dynamic": "Dynamic",
    "Tempo": "DirectionText", "StaffText": "DirectionText", "Expression": "DirectionText",
}

#: Never emitted, never requested, and fatal if a response advertises it.
PROHIBITED_HEAD_FAMILIES = frozenset({"dynamic.mark"})


class FusionPolicyError(RuntimeError):
    """A violation that must fail the request rather than degrade it."""


@dataclass(frozen=True)
class DetectorCandidate:
    """One proposed region, with the provenance a decision has to be attributable to."""

    candidate_id: str
    detector_id: str
    label: str
    box: tuple[int, int, int, int]  # left, top, right, bottom; right/bottom exclusive
    raw_confidence: float
    calibrated_confidence: float | None = None

    @property
    def area(self) -> int:
        left, top, right, bottom = self.box
        return max(0, right - left) * max(0, bottom - top)


def assert_no_prohibited_families(families: Iterable[str]) -> None:
    """Fail closed on a prohibited head family, wherever it is advertised or emitted."""
    offending = sorted(PROHIBITED_HEAD_FAMILIES.intersection(families))
    if offending:
        raise FusionPolicyError(f"prohibited head family advertised: {offending}")


def is_valid_box(box: object, page: tuple[int, int]) -> bool:
    """A box worth considering at all: finite, ordered, on the page, non-negligible.

    A materially out-of-bounds box is invalid evidence rather than something to clamp;
    only a one-pixel rounding excursion is forgiven, which is done by the caller when it
    builds the candidate.
    """
    if not isinstance(box, tuple) or len(box) != 4:
        return False
    if not all(isinstance(value, int) for value in box):
        return False
    left, top, right, bottom = box
    width, height = page
    if right <= left or bottom <= top:
        return False
    if left < 0 or top < 0 or right > width or bottom > height:
        return False
    return (right - left) * (bottom - top) > 0


def gate(
    candidates: Sequence[DetectorCandidate], page: tuple[int, int],
    *, class_allowlist: dict[str, frozenset[str]] | None = None,
) -> tuple[list[DetectorCandidate], list[tuple[DetectorCandidate, str]]]:
    """Split candidates into those a detector may contribute and those it may not.

    Returns `(accepted, rejected)` where each rejection carries its reason, because a
    silently dropped candidate cannot be told from one that was never predicted.
    """
    accepted: list[DetectorCandidate] = []
    rejected: list[tuple[DetectorCandidate, str]] = []
    for candidate in candidates:
        allowed = (CLASS_ALLOWLIST if class_allowlist is None else class_allowlist).get(candidate.detector_id)
        if allowed is None:
            rejected.append((candidate, "unknown-detector"))
        elif candidate.label not in allowed:
            rejected.append((candidate, "unsupported-class"))
        elif not is_valid_box(candidate.box, page):
            rejected.append((candidate, "invalid-box"))
        else:
            accepted.append(candidate)
    return accepted, rejected


def intersection_area(first: DetectorCandidate, second: DetectorCandidate) -> int:
    left = max(first.box[0], second.box[0])
    top = max(first.box[1], second.box[1])
    right = min(first.box[2], second.box[2])
    bottom = min(first.box[3], second.box[3])
    return max(0, right - left) * max(0, bottom - top)


def conflicts(
    first: DetectorCandidate,
    second: DetectorCandidate,
    *,
    iou_threshold: float,
    containment_threshold: float,
) -> bool:
    """Whether two candidates are competing for the same ink.

    Two tests, not one. IoU alone is deceptively low for a small label sitting inside a
    much larger conflicting region, so intersection over the *smaller* box is checked
    too. Merely touching edges is not a conflict: both tests are strict inequalities
    over a zero intersection.
    """
    overlap = intersection_area(first, second)
    if overlap <= 0:
        return False
    union = first.area + second.area - overlap
    if union > 0 and overlap / union > iou_threshold:
        return True
    smaller = min(first.area, second.area)
    return smaller > 0 and overlap / smaller > containment_threshold


def conflict_components(
    candidates: Sequence[DetectorCandidate],
    *,
    iou_threshold: float,
    containment_threshold: float,
) -> list[list[int]]:
    """Indices grouped into connected components of the conflict graph.

    Resolved together rather than pairwise, so one broad candidate overlapping several
    smaller ones cannot produce an outcome that depends on input order. Each component
    is returned sorted, and components are ordered by their first member, so the result
    is a function of the set of candidates and nothing else.
    """
    parent = list(range(len(candidates)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            if conflicts(
                candidates[i],
                candidates[j],
                iou_threshold=iou_threshold,
                containment_threshold=containment_threshold,
            ):
                parent[find(i)] = find(j)

    groups: dict[int, list[int]] = {}
    for index in range(len(candidates)):
        groups.setdefault(find(index), []).append(index)
    return sorted((sorted(group) for group in groups.values()), key=lambda g: g[0])


def resolve_component(
    component: Sequence[DetectorCandidate],
    *,
    accept_threshold: Callable[[str], float | None],
    minimum_margin: float,
) -> tuple[DetectorCandidate | None, str]:
    """The winner of one conflict component, or None with the reason it was withheld.

    A single candidate is accepted only if its calibrated score clears its class's
    threshold. A contested component needs a unique leader that clears its threshold and
    leads the runner-up by `minimum_margin`. Anything else is review work, which is the
    design's whole point: an unresolved overlap is visible, never an arbitrary win.

    A candidate with no calibrated score can never win. Its raw confidence is a mean
    pixel probability and comparing it across detectors or classes is exactly the
    mistake this module exists to prevent.
    """
    scored = [
        (candidate, candidate.calibrated_confidence)
        for candidate in component
        if candidate.calibrated_confidence is not None
    ]
    if not scored:
        return None, "below-threshold"

    scored.sort(key=lambda pair: pair[1], reverse=True)
    best, best_score = scored[0]
    threshold = accept_threshold(best.label)
    if threshold is None or best_score < threshold:
        return None, "below-threshold"
    if len(scored) > 1:
        runner_up = scored[1][1]
        if best_score - runner_up < minimum_margin:
            return None, "insufficient-margin"
        if best_score == runner_up:
            return None, "insufficient-margin"
    return best, "calibrated-winner" if len(component) > 1 else "independent"
