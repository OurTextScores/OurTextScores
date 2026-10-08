from qualify_lyric_ocr import classify_token, edit_leq_one, lyric_like, source_vocabulary, summarize, tokens


def test_tokens_fold_case_and_diacritics_and_split_on_hyphen_underscore():
    assert tokens("Fisch_lein, wish -ing") == ["fisch", "lein", "wish", "ing"]
    assert tokens("Süß, I") == ["suss"] or tokens("Süß, I") == ["sus"] or tokens("Süß, I")[0].startswith("su")
    assert tokens("a 1 .") == []


def test_edit_distance_one_and_token_kinds():
    assert edit_leq_one("lein", "leln") and edit_leq_one("lein", "leine") and not edit_leq_one("lein", "lxxn")
    vocab = {"fisch", "lein", "forelle"}
    assert classify_token("fisch", vocab) == "exact"
    assert classify_token("forele", vocab) == "near"
    assert classify_token("fin", vocab) == "none"  # under 4 characters never fuzzy-matches


def test_lyric_like_needs_most_tokens_in_the_source_and_empty_is_unscored():
    vocab = source_vocabulary([{"score": "s", "text": "Fisch"}, {"score": "s", "text": "lein"}])["s"]
    assert lyric_like("Fisch_lein", vocab)[0] is True
    assert lyric_like("tempo primo", vocab)[0] is False
    assert lyric_like("1 .", vocab) == (None, [])


def test_summary_computes_precision_retention_and_exactness():
    rows = [
        {"lyricLike": True, "proposed": True, "kinds": ["exact", "near"]},
        {"lyricLike": True, "proposed": False, "kinds": ["exact"]},
        {"lyricLike": False, "proposed": True, "kinds": ["none"]},
        {"lyricLike": None, "proposed": False, "kinds": []},
    ]
    s = summarize(rows)
    assert s["proposedPrecision"] == 0.5 and s["gateRetention"] == 0.5
    assert s["exactTokenShareInLyricRows"] == 2 / 3 and s["withheldLyricLike"] == 1
