from lyric_attachment_policy import LyricBox, NoteAnchor, attach_nearest_x


def note(ordinal, x, top=100, bottom=130):
    return NoteAnchor("P1", ordinal, str(ordinal - 1), x, top, bottom)


def box(identifier, x, y=115):
    return LyricBox(identifier, identifier, x, y, "1", 0.8)


def test_nearest_x_uses_only_the_matching_staff_band():
    result = attach_nearest_x("page", [box("a", 19)], [note(1, 10), note(2, 20, 300, 330)])
    assert [(row.detector_box_id, row.source_note_ordinal) for row in result] == [("a", 1)]


def test_boxes_without_a_staff_match_are_review_items():
    assert attach_nearest_x("page", [box("a", 19, 200)], [note(1, 10)]) == []


def test_multiple_boxes_are_preserved_for_separate_scoring():
    result = attach_nearest_x("page", [box("a", 19), box("b", 21)], [note(1, 10), note(2, 20)])
    assert [row.detector_box_id for row in result] == ["a", "b"]
