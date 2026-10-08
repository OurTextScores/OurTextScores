from collect_lyric_calibration import coverage
from select_lyric_calibration_pages import select


def test_coverage_is_the_exact_union_not_a_sum():
    box = [0, 0, 10, 10]
    assert coverage(box, [[0, 0, 10, 5], [0, 0, 10, 5]]) == 0.5
    assert coverage(box, [[0, 0, 5, 10], [5, 0, 10, 10]]) == 1.0
    assert coverage(box, [[20, 20, 30, 30]]) == 0.0
    assert coverage(box, [[0, 0, 10, 4], [0, 3, 10, 6]]) == 0.6


def page(score, corpus, sha, lyrics=True, complete=(), w=100, h=100, part="calibration"):
    return {
        "score": score, "corpus": corpus, "pixel_sha256": sha, "partition": part, "width": w,
        "height": h, "complete_semantic_families": list(complete),
        "ground_truth": [{"semanticFamily": "Lyrics"}] if lyrics else [],
    }


def test_selection_is_per_score_capped_ordered_by_pixel_hash_and_calibration_only():
    rows = [page("a", "lieder", s) for s in "cba"] + [page("a", "lieder", "z", part="test")]
    rows += [page("o", "ossq", s, lyrics=False, complete=["Lyrics"]) for s in "54321"]
    rows += [page("big", "lieder", "q", w=5000, h=5000), page("v", "ossq", "x", lyrics=False)]
    chosen = select(rows, 2, 3)
    assert [r["pixel_sha256"] for r in chosen if r["score"] == "a"] == ["a", "b"]
    assert [r["pixel_sha256"] for r in chosen if r["score"] == "o"] == ["1", "2", "3"]
    assert {r["score"] for r in chosen} == {"a", "o"}
