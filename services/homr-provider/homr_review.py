"""Select and rank the spots worth asking a reviewer about.

Design §4. Two separate decisions, deliberately kept apart:

* **Filtering** decides what is worth a question at all, and musical impact
  belongs here — a doubtful slur matters less than a doubtful pitch, so a
  low-impact head has to be *more* uncertain to qualify.
* **Ranking** is strictly by ascending confidence, least certain first, and
  impact is deliberately absent. The queue is open-ended, and its whole value is
  that the reviewer can be told:

      19 spots left, all at least 84% confident.

  That is only true, and only checkable, if the queue is monotonic in
  confidence. A weighted ordering would buy slightly better expected value per
  question and lose the ability to say anything honest about the remainder.
"""

from __future__ import annotations

from typing import Any

# A head qualifies when its confidence is below the floor for its impact class.
# Pitch and rhythm change the music; the rest are decoration by comparison, so
# they must be considerably more doubtful before they are worth interrupting for.
DEFAULT_FLOOR = 0.80
LOW_IMPACT_FLOOR = 0.50
LOW_IMPACT_HEADS = frozenset({"slur", "articulation"})

# Require a plausible alternative: the runner-up must be at least this fraction
# of the chosen value. A 0.60/0.05 spread is uncertainty with nothing to offer
# instead; 0.45/0.40 is a real question.
#
# A ratio, not an absolute gap. Probabilities sum to one, so an absolute margin
# is unsatisfiable at higher confidences — at 0.72 the runner-up cannot exceed
# 0.28, making the gap at least 0.44 — which would silently cap the effective
# floor near 0.62 no matter what floor was configured.
DEFAULT_MIN_ALTERNATIVE_RATIO = 0.25

# `position` is an internal grand-staff assignment rather than something a
# reviewer can judge from a crop, and `lift` is covered by the pitch question.
ASKABLE_HEADS = ("pitch", "rhythm", "lift", "articulation", "slur")


def floor_for(head: str, floor: float) -> float:
    if head in LOW_IMPACT_HEADS:
        return min(floor, LOW_IMPACT_FLOOR)
    return floor


def select_spots(
    staves: list[dict[str, Any]],
    *,
    floor: float = DEFAULT_FLOOR,
    min_alternative_ratio: float = DEFAULT_MIN_ALTERNATIVE_RATIO,
) -> list[dict[str, Any]]:
    """Return every askable spot, least certain first.

    No cap: a fixed budget is the designer guessing at someone else's attention
    span. The caller stops when the remainder is good enough, which is why the
    result is ordered and why `remaining_floor` exists.
    """
    spots: list[dict[str, Any]] = []
    for staff in staves:
        for symbol in staff.get("symbols", []):
            for head in ASKABLE_HEADS:
                entry = (symbol.get("heads") or {}).get(head)
                if not entry:
                    continue
                confidence = float(entry.get("confidence", 1.0))
                if confidence >= floor_for(head, floor):
                    continue
                alternatives = entry.get("alternatives") or []
                if not alternatives:
                    continue
                runner_up = float(alternatives[0].get("confidence", 0.0))
                if runner_up < confidence * min_alternative_ratio:
                    continue
                spots.append(
                    {
                        "staffIndex": staff.get("index"),
                        "symbolIndex": symbol.get("index"),
                        "head": head,
                        "chosen": entry.get("chosen"),
                        "confidence": confidence,
                        "alternatives": alternatives,
                        "attention": symbol.get("attention"),
                    }
                )
    # Ties broken by position so the order is stable across identical scans.
    spots.sort(
        key=lambda spot: (
            spot["confidence"],
            spot["staffIndex"] or 0,
            spot["symbolIndex"] or 0,
        )
    )
    return spots


def remaining_floor(spots: list[dict[str, Any]], answered: int) -> float | None:
    """Confidence of the least certain spot still unanswered.

    This is the number behind "N left, all at least X% confident". Because the
    queue is sorted ascending, it is simply the next one — and it rises as the
    reviewer works, which is what makes stopping an evidence-based decision.
    """
    if answered >= len(spots):
        return None
    return float(spots[answered]["confidence"])
