"""Explicit baseline attachment policy; never enabled by the scanner automatically."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from lyric_attachment import LyricAttachment


@dataclass(frozen=True)
class NoteAnchor:
    source_part: str
    source_note_ordinal: int
    onset_quarters: str
    center_x: float
    staff_top: float
    staff_bottom: float
    physical_measure: int


@dataclass(frozen=True)
class LyricBox:
    detector_box_id: str
    text: str
    center_x: float
    center_y: float
    verse: str
    confidence: float


def attach_nearest_x(
    page_id: str,
    boxes: Iterable[LyricBox],
    notes: Iterable[NoteAnchor],
) -> list[LyricAttachment]:
    """Attach boxes to the nearest note in the explicitly matching staff band.

    This is a diagnostic baseline. It refuses boxes without a matching vocal staff and
    preserves multiple boxes instead of deduplicating them. A future policy must beat this
    baseline on native source targets before it can be considered for fusion.
    """

    anchors = list(notes)
    result = []
    for box in boxes:
        candidates = [
            note
            for note in anchors
            if note.staff_top <= box.center_y <= note.staff_bottom
        ]
        if not candidates:
            continue
        chosen = min(candidates, key=lambda note: abs(note.center_x - box.center_x))
        result.append(
            LyricAttachment(
                page_id=page_id,
                detector_box_id=box.detector_box_id,
                text=box.text,
                verse=box.verse,
                source_part=chosen.source_part,
                physical_measure=chosen.physical_measure,
                source_note_ordinal=chosen.source_note_ordinal,
                onset_quarters=chosen.onset_quarters,
                confidence=box.confidence,
            )
        )
    return result
