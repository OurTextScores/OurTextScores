from lyric_ocr import MIN_COVERAGE, select_rows, union_coverage


def row(box, text="x"):
    x0, y0, x1, y1 = box
    return {"box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], "text": text, "confidence": 0.9}


def test_union_coverage_counts_overlaps_once():
    assert union_coverage((0, 0, 10, 10), [(0, 0, 10, 5), (0, 3, 10, 6)]) == 0.6
    assert union_coverage((0, 0, 10, 10), [(20, 20, 30, 30)]) == 0.0
    assert union_coverage((0, 0, 0, 10), [(0, 0, 5, 5)]) == 0.0


def test_rows_are_selected_by_lyric_region_coverage_and_small_regions_are_ignored():
    regions = [(0, 0, 100, 20), (200, 200, 205, 205)]  # second region is below the area floor
    rows = [row((10, 2, 50, 12), "inside"), row((10, 30, 50, 40), "below"), row((200, 200, 204, 204), "speck")]
    kept = select_rows(rows, regions)
    assert [r["text"] for r in kept] == ["inside"]
    assert kept[0]["regionCoverage"] >= MIN_COVERAGE
    # A row only 10% covered still counts; 9% does not.
    assert select_rows([row((0, 0, 1000, 10))], [(0, 0, 100, 10)])[0]["regionCoverage"] == 0.1
    assert select_rows([row((0, 0, 1000, 10))], [(0, 0, 90, 10)]) == []
