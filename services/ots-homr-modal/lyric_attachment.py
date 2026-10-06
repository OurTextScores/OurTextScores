"""Off-by-default contract for native-ground-truth lyric attachment evaluation.

The scanner does not produce these records yet. Keeping the schema separate prevents
detector boxes or OCR text from being mistaken for note ownership.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any


@dataclass(frozen=True)
class LyricAttachment:
    page_id: str
    detector_box_id: str
    text: str
    verse: str
    source_part: str
    physical_measure: int
    source_note_ordinal: int
    onset_quarters: str
    confidence: float

    def __post_init__(self) -> None:
        if not self.page_id or not self.detector_box_id or not self.source_part:
            raise ValueError("attachment identity fields are required")
        if not self.text:
            raise ValueError("attachment text is required")
        if not self.verse:
            raise ValueError("attachment verse is required")
        if type(self.physical_measure) is not int or self.physical_measure < 1:
            raise ValueError("physical measure must be a positive integer")
        if type(self.source_note_ordinal) is not int or self.source_note_ordinal < 1:
            raise ValueError("source note ordinal must be positive")
        Fraction(self.onset_quarters)
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("attachment confidence must be between zero and one")

    def as_dict(self) -> dict[str, Any]:
        return {
            "page_id": self.page_id,
            "detector_box_id": self.detector_box_id,
            "text": self.text,
            "verse": self.verse,
            "source_part": self.source_part,
            "physical_measure": self.physical_measure,
            "source_note_ordinal": self.source_note_ordinal,
            "onset_quarters": self.onset_quarters,
            "confidence": self.confidence,
        }


def validate_attachments(records: list[dict[str, Any]]) -> list[LyricAttachment]:
    """Validate a producer's records without changing or deduplicating them."""

    return [LyricAttachment(**record) for record in records]
