"""Prune the per-symbol distributions down to what is worth sending.

Selection — which spots to actually ask a reviewer about, and in what order —
deliberately lives in the **backend**, not here (design §4, §10). Its thresholds
have to be tuned against real reviewer behaviour, and doing that must not mean
re-scanning every page through a GPU. The backend therefore stores the raw
distributions and re-selects from them whenever the thresholds move.

What happens here is only the size reduction: a clean page is confident almost
everywhere, and shipping the top-4 alternatives for every head of every symbol
would be mostly noise. Anything above the prune floor cannot qualify under any
plausible selection threshold, so it is dropped before the response is built.
"""

from __future__ import annotations

from typing import Any

# Deliberately far above any selection floor the backend would use, so pruning
# can never remove a spot that selection would have wanted.
PRUNE_FLOOR = 0.95

# `position` is an internal grand-staff assignment rather than anything a
# reviewer could judge from a crop, so it never reaches the UI. Kept in the
# payload for debugging is not worth the bytes.
DROPPED_HEADS = frozenset({"position"})


def prune_staves(staves: list[dict[str, Any]], floor: float = PRUNE_FLOOR) -> list[dict[str, Any]]:
    """Drop symbols the model was sure about, and heads no one can review."""
    pruned: list[dict[str, Any]] = []
    for staff in staves:
        symbols = []
        for symbol in staff.get("symbols", []):
            heads = {
                name: entry
                for name, entry in (symbol.get("heads") or {}).items()
                if name not in DROPPED_HEADS
            }
            if not heads:
                continue
            if all(float(entry.get("confidence", 1.0)) >= floor for entry in heads.values()):
                continue
            symbols.append({**symbol, "heads": heads})
        # Geometry and the token sequence are kept whole: the crop is built
        # from one and regeneration from the other, and both are small next to
        # the distributions that dominate the payload.
        pruned.append({**staff, "symbols": symbols})
    return pruned
