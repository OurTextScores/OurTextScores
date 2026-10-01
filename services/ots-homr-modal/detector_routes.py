"""Route physical page detections into exclusive logical class ownership."""

from collections.abc import Mapping, Sequence
from typing import Any

from pins import DETECTOR_ROUTES


def route_detections(
    physical: Mapping[str, Sequence[Mapping[str, Any]]],
) -> dict[str, list[Mapping[str, Any]]]:
    if set(physical) != set(DETECTOR_ROUTES.values()):
        raise ValueError("All physical detector runs are required, including empty runs")
    routed = {}
    for logical, source in DETECTOR_ROUTES.items():
        rows = physical[source]
        if logical == "dynamics":
            routed[logical] = [row for row in rows if row.get("label") == "Dynamic"]
        elif logical == "non-lyric-text" and source == DETECTOR_ROUTES["dynamics"]:
            routed[logical] = [row for row in rows if row.get("label") != "Dynamic"]
        else:
            # Preserve unsupported evidence for explicit gate/rejection reasons.
            routed[logical] = list(rows)
    return routed
