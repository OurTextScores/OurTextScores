from fit_lyric_calibration import choose_accept, negative_rates, tall_box_rate


def test_accept_is_the_lowest_band_at_target_and_none_when_unreached():
    bands = [{"lowerEdge": 0.5, "calibrated": 0.6}, {"lowerEdge": 0.7, "calibrated": 0.9}, {"lowerEdge": 0.9, "calibrated": 0.95}]
    assert choose_accept(bands)["lowerEdge"] == 0.7
    assert choose_accept(bands[:1]) is None


def test_negative_rates_count_at_or_above_each_edge_per_instrumental_page():
    rows = [{"status": "negative", "band": 0}, {"status": "negative", "band": 3}, {"status": "matched", "band": 4}]
    rates = negative_rates(rows, 2)
    assert rates[0] == {"rawAtLeast": 0.5, "falsePositives": 2, "perInstrumentalPage": 1.0}
    assert rates[4]["falsePositives"] == 0 and rates[3]["falsePositives"] == 1


def test_tall_box_rate_is_per_page_median_and_ignores_instrumental_and_sparse_pages():
    def box(h):
        return {"rawConfidence": 0.9, "box": [0, 0, 10, h]}

    vocal = {"corpus": "lieder", "boxes": [box(10), box(10), box(10), box(25)]}
    sparse = {"corpus": "lieder", "boxes": [box(10), box(99)]}
    instrumental = {"corpus": "ossq", "boxes": [box(10)] * 3 + [box(99)]}
    rate = tall_box_rate([vocal, sparse, instrumental])
    assert (rate["boxes"], rate["taller"]) == (4, 1)
