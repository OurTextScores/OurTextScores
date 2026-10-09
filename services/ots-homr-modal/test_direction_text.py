from direction_text import (
    MAX_DIRECTION_ROWS,
    canonical_dynamic,
    direction_kind,
    direction_rows,
    merge_hyphen_chains,
    split_fused_dynamic,
)


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
    assert direction_rows([r("poco rubato", box=(1, 1, 2, 2))], [[1, 1, 2, 2]])["rows"] == []
    many = [r("cresc.", box=(0, i, 5, i + 5)) for i in range(MAX_DIRECTION_ROWS + 7)]
    capped = direction_rows(many, [])
    assert len(capped["rows"]) == MAX_DIRECTION_ROWS and capped["rowsOmitted"] == 7


def test_strict_terms_are_directions_even_when_the_gate_calls_them_lyrics():
    assert direction_kind("dim. -", "Lyrics") == "words"
    assert direction_kind("rit.", "Lyrics") == "words"
    assert direction_kind("Ritter", "Lyrics") is None  # a sung word that merely starts like "rit"
    out = direction_rows([r("dim. -", semantic="Lyrics", lyric=True)], [])
    assert [x["text"] for x in out["rows"]] == ["dim. -"]


def test_a_fused_dynamic_and_word_are_split_only_for_known_terms():
    parts = split_fused_dynamic(r("pdolce", box=(100, 10, 220, 40)))
    assert [(p["text"], p["box"]) for p in parts] == [("p", [100, 10, 120, 40]), ("dolce", [120, 10, 220, 40])]
    assert len(split_fused_dynamic(r("poco", box=(0, 0, 40, 10)))) == 1  # p + oco is not a split
    assert len(split_fused_dynamic(r("forte", box=(0, 0, 50, 10)))) == 1
    out = direction_rows([r("pdolce", box=(100, 10, 220, 40))], [])
    assert [(x["kind"], x["text"]) for x in out["rows"]] == [("dynamic", "p"), ("words", "dolce")]


def test_a_spread_out_word_is_joined_across_hyphen_and_dropped_hyphen_pieces():
    pieces = [r("cre-", box=(100, 100, 200, 140)), r("scen", box=(560, 102, 660, 140)), r("do", box=(800, 100, 860, 140))]
    assert [m["text"] for m in merge_hyphen_chains(pieces)] == ["crescendo"]
    out = direction_rows([{**p, "semantic": "Lyrics"} for p in pieces], [])
    assert [(x["text"], x["box"]) for x in out["rows"]] == [("crescendo", [100, 100, 860, 140])]
    # A different line, or a gap too wide, does not chain.
    assert merge_hyphen_chains([r("cre-", box=(0, 0, 90, 40)), r("do", box=(0, 300, 60, 340))]) == []
    assert merge_hyphen_chains([r("cre-", box=(0, 0, 90, 40)), r("do", box=(2000, 0, 2060, 40))]) == []
