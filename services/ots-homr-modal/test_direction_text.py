from direction_text import MAX_DIRECTION_ROWS, canonical_dynamic, direction_kind, direction_rows


def r(text, semantic="DirectionText", box=(0, 0, 10, 10), lyric=False):
    return {"box": list(box), "text": text, "ocrConfidence": 0.9, "semantic": semantic, "semanticScore": 0.1, "proposedLyric": lyric}


def test_dynamic_marks_are_recognised_with_ocr_punctuation():
    assert canonical_dynamic("pp") == "pp"
    assert canonical_dynamic(" mf. ") == "mf"
    assert canonical_dynamic("più f") is None
    assert direction_kind("p", "Lyrics") == "dynamic"  # a bare mark is a dynamic whatever the gate says


def test_words_need_the_gate_and_enough_letters():
    assert direction_kind("cresc. poco a poco", "DirectionText") == "words"
    assert direction_kind("Un poco agitato", "DirectionText") == "words"
    assert direction_kind("17", "DirectionText") is None  # measure/rehearsal number
    assert direction_kind("do", "DirectionText") is None  # fragment
    assert direction_kind("Langsam und leise.", "Lyrics") is None  # the gate withholds it (reviewer can still find it as a lyric)


def test_rows_proposed_as_lyrics_are_never_offered_and_output_is_reading_ordered_and_bounded():
    rows = [r("rit.", box=(50, 100, 80, 110)), r("cresc.", box=(10, 20, 40, 30)), r("dolce", semantic="Lyrics", lyric=True, box=(5, 5, 9, 9))]
    out = direction_rows(rows, [])
    assert [x["text"] for x in out["rows"]] == ["cresc.", "rit."]
    assert direction_rows([r("rit.", box=(1, 1, 2, 2))], [[1, 1, 2, 2]])["rows"] == []
    many = [r("cresc.", box=(0, i, 5, i + 5)) for i in range(MAX_DIRECTION_ROWS + 7)]
    capped = direction_rows(many, [])
    assert len(capped["rows"]) == MAX_DIRECTION_ROWS and capped["rowsOmitted"] == 7
