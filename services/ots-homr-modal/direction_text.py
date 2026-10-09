"""Direction-text and dynamics candidates from full-page OCR rows, for review (never written without a reviewer).

The 2026-10-08 proof of concept found that OCR plus the frozen semantic gate reads written directions far
better than the available direction detectors (24/37 vs 8/37 native words on 10 Lieder pages), so candidates
come from OCR rows, not detector boxes. A row is a *dynamic* when it is exactly a dynamic mark, a *words*
direction when the gate calls it DirectionText and it is a readable word (not a number or a fragment).
Rows already proposed as lyrics are never offered. OCR text is unreviewed.
"""

from __future__ import annotations

import re
from typing import Any, Sequence

DYNAMIC_MARKS = frozenset(
    {"p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "rf", "rfz", "fz", "sfp"}
)
MAX_DIRECTION_ROWS = 120
MIN_WORD_LETTERS = 3
_LETTERS = re.compile(r"[^\W\d_]", re.UNICODE)


def canonical_dynamic(text: str) -> str | None:
    token = re.sub(r"[\s.,;:!\-_]+", "", text.lower())
    return token if token in DYNAMIC_MARKS else None


def direction_kind(text: str, semantic: str) -> str | None:
    """'dynamic', 'words' or None (not a direction candidate)."""
    if canonical_dynamic(text):
        return "dynamic"
    if semantic != "DirectionText":
        return None
    letters = len(_LETTERS.findall(text))
    if letters < MIN_WORD_LETTERS:  # numbers, rehearsal marks, stray syllable fragments
        return None
    return "words"


def direction_rows(rows: Sequence[dict[str, Any]], lyric_boxes: Sequence[Sequence[int]]) -> dict[str, Any]:
    """`rows` are classified OCR rows (box [l,t,r,b], text, ocrConfidence, semantic, semanticScore)."""
    taken = {tuple(box) for box in lyric_boxes}
    out = []
    for row in rows:
        if tuple(row["box"]) in taken or row.get("proposedLyric"):
            continue
        kind = direction_kind(row["text"], row["semantic"])
        if kind is None:
            continue
        out.append({**row, "kind": kind, **({"mark": canonical_dynamic(row["text"])} if kind == "dynamic" else {})})
    out.sort(key=lambda r: (r["box"][1], r["box"][0]))
    return {"rows": out[:MAX_DIRECTION_ROWS], "rowsOmitted": max(0, len(out) - MAX_DIRECTION_ROWS)}
