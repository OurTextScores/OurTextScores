import pytest

from lyric_attachment import LyricAttachment
from lyric_attachment_evaluation import score_linked_attachments


def row(box="a", **changes):
    data = dict(page_id="p", detector_box_id=box, text="Hal", verse="1",
                source_part="P1", physical_measure=4, source_note_ordinal=1,
                onset_quarters="1/2", confidence=0.8)
    data.update(changes)
    return LyricAttachment(**data)


def test_same_ordinal_in_another_measure_is_wrong_ownership():
    result = score_linked_attachments([row()], [row(physical_measure=5)], [("p", "a")])
    assert result["text_correct"] == 1
    assert result["ownership_correct"] == result["jointly_correct"] == 0


def test_stage_failures_and_duplicates_are_not_silently_scored():
    refs = [row(x) for x in "abcd"]
    preds = [row("c"), row("c"), row("d", text="wrong"), row("extra")]
    result = score_linked_attachments(refs, preds, [("p", x) for x in ["b", "c", "d", "extra"]])
    assert result == dict(references=4, detector_misses=1, unresolved_detected=1,
                         duplicate_boxes=1, scored=1, text_correct=0,
                         ownership_correct=1, jointly_correct=0, unlinked_predictions=1)


def test_equivalent_rational_onsets_match():
    result = score_linked_attachments([row()], [row(onset_quarters="2/4")], [("p", "a")])
    assert result["jointly_correct"] == 1


def test_uncertified_or_inconsistent_links_fail():
    with pytest.raises(ValueError):
        score_linked_attachments([row(), row()], [], [])
    with pytest.raises(ValueError):
        score_linked_attachments([row()], [row()], [])
