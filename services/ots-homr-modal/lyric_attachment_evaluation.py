"""Stage-specific attachment scoring for independently linked lyric boxes.

References must already bind a box ID to native source ownership. This module
never creates that linkage from predicted text or geometry.
"""

from collections import Counter
from fractions import Fraction
from typing import Iterable

from lyric_attachment import LyricAttachment


def ownership(row: LyricAttachment) -> tuple:
    return (
        row.source_part,
        row.physical_measure,
        row.source_note_ordinal,
        Fraction(row.onset_quarters),
        row.verse,
    )


def score_linked_attachments(
    references: Iterable[LyricAttachment],
    predictions: Iterable[LyricAttachment],
    detected_boxes: Iterable[tuple[str, str]],
) -> dict[str, int]:
    """Score certified (page, box) links; missing production records stay missing.

    A detected box without attachment is unresolved; it is not automatically
    an OCR error. Text and ownership are checked independently, literally.
    Duplicate predictions are counted and excluded from conditional scoring.
    Unlinked predictions are reported, not labelled false positives.
    """
    refs = list(references)
    preds = list(predictions)
    def key(row: LyricAttachment) -> tuple[str, str]:
        return row.page_id, row.detector_box_id

    ref_map = {key(row): row for row in refs}
    if len(ref_map) != len(refs):
        raise ValueError("reference box links must be unique")
    detected = set(detected_boxes)
    if any(key(row) not in detected for row in preds):
        raise ValueError("attachment refers to a box absent from detector output")
    counts = Counter(key(row) for row in preds)
    pred_map = {key(row): row for row in preds}
    result = dict(
        references=len(refs), detector_misses=0, unresolved_detected=0,
        duplicate_boxes=0, scored=0, text_correct=0, ownership_correct=0,
        jointly_correct=0, unlinked_predictions=sum(key(row) not in ref_map for row in preds),
    )
    for identifier, ref in ref_map.items():
        if identifier not in detected:
            result["detector_misses"] += 1
        elif identifier not in pred_map:
            result["unresolved_detected"] += 1
        elif counts[identifier] != 1:
            result["duplicate_boxes"] += 1
        else:
            pred = pred_map[identifier]
            text_ok = pred.text == ref.text
            ownership_ok = ownership(pred) == ownership(ref)
            result["scored"] += 1
            result["text_correct"] += int(text_ok)
            result["ownership_correct"] += int(ownership_ok)
            result["jointly_correct"] += int(text_ok and ownership_ok)
    return result
