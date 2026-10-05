import pytest

from lyric_attachment import LyricAttachment, validate_attachments


def record(**overrides):
    value = {
        "page_id": "page-1",
        "detector_box_id": "box-1",
        "text": "Hal",
        "verse": "1",
        "source_part": "P1",
        "source_note_ordinal": 12,
        "onset_quarters": "3/2",
        "confidence": 0.8,
    }
    value.update(overrides)
    return value


def test_attachment_round_trips_as_explicit_native_target_tuple():
    item = LyricAttachment(**record())
    assert item.as_dict() == record()


def test_validation_preserves_order_and_duplicates():
    rows = validate_attachments([record(), record(detector_box_id="box-2")])
    assert [row.detector_box_id for row in rows] == ["box-1", "box-2"]


@pytest.mark.parametrize(
    "field,value",
    [("source_note_ordinal", 0), ("confidence", 1.1), ("onset_quarters", "bad")],
)
def test_invalid_native_attachment_fields_fail_closed(field, value):
    with pytest.raises(ValueError):
        LyricAttachment(**record(**{field: value}))
