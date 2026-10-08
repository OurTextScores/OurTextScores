import pytest

from lyric_calibration_sample import band, candidates, fit, pav, sample_unmatched


def page(pid, score, boxes, corpus="lieder"):
    return {"id": pid, "score": score, "corpus": corpus, "boxes": boxes}


def b(conf, cov=0.0, neg=False):
    return {"box": [0, 0, 10, 10], "rawConfidence": conf, "knownCoverage": cov, "verifiedNegative": neg}


def test_bands_and_status():
    assert band(0.49) is None and band(0.5) == 0 and band(0.69) == 1 and band(1.0) == 4
    rows = list(candidates([page("p", "s", [b(0.3), b(0.55, 0.9), b(0.65), b(0.95, 0, True)])]))
    assert [(r["band"], r["status"]) for r in rows] == [(0, "matched"), (1, "unmatched"), (4, "negative")]


def test_sample_is_stable_capped_per_score_and_unmatched_only():
    rows = [
        {"id": f"{s}{i}", "score": s, "band": 2, "status": "unmatched"} for s in "ab" for i in range(10)
    ] + [{"id": "m", "score": "c", "band": 2, "status": "matched"}]
    first = sample_unmatched(rows, per_band=30, per_score=3)
    assert first == sample_unmatched(list(reversed(rows)), per_band=30, per_score=3)
    assert len(first) == 6 and {r["score"] for r in first} == {"a", "b"}


def test_pav_pools_violations_and_is_monotone():
    assert pav([0.6, 0.57, 0.8], [1, 1, 1]) == pytest.approx([0.585, 0.585, 0.8])
    assert pav([0.1, 0.2, 0.3], [1, 1, 1]) == [0.1, 0.2, 0.3]


def test_fit_uses_judged_rate_for_unmatched_and_refuses_unjudged_bands():
    rows = [{"id": f"m{i}", "band": 0, "status": "matched"} for i in range(6)]
    rows += [{"id": f"u{i}", "band": 0, "status": "unmatched"} for i in range(4)]
    bands = fit(rows, {"u0": "lyric", "u1": "not-lyric", "u2": "unsure"})
    assert bands[0]["usable"] == 2 and bands[0]["unsure"] == 1
    assert bands[0]["precision"] == pytest.approx((6 + 0.5 * 4) / 10)
    assert bands[1]["precision"] is None
    with pytest.raises(ValueError):
        fit(rows, {})
