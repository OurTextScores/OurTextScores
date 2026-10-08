import json

import pytest

from build_fusion_v1_manifest import build
from calibration_manifest import load_calibration_manifest
from pins import DETECTORS


def report(accept=0.7):
    bands = [
        {"lowerEdge": e, "calibrated": c}
        for e, c in zip([0.5, 0.6, 0.7, 0.8, 0.9], [0.6, 0.6, 0.8, 0.91, 0.95])
    ]
    return {
        "schemaVersion": "ots.lyric-calibration-fit.v1", "targetPrecision": 0.9, "bands": bands,
        "acceptLowerEdge": 0.8, "pages": {}, "negativeRates": [], "caveats": ["c"],
        "acceptChoice": {"rule": "t"}, "definition": "d", "tallBoxProxy": {},
        "sizeGate": {"minBoxArea": {"Lyrics": 200}, "maxPageAreaFraction": 0.25},
    }


def test_manifest_loads_calibrates_lyrics_and_leaves_e4_in_review(tmp_path):
    path = tmp_path / "m.json"
    path.write_text(json.dumps(build(report(), "2026-10-08"), indent=1, sort_keys=True))
    manifest = load_calibration_manifest(path)
    lyrics = DETECTORS["lyrics"]
    manifest.assert_detector_matches("lyrics", sha256=lyrics[3], revision=lyrics[1])
    assert manifest.min_box_area == {"Lyrics": 200} and manifest.max_page_area_fraction == 0.25
    assert manifest.calibrate("lyrics", "Lyrics", 0.85) == 0.91
    assert manifest.calibrate("lyrics", "Lyrics", 0.4) is None
    assert manifest.accept_threshold("lyrics")("Lyrics") == 0.91
    for logical, label in (("non-lyric-text", "Tempo"), ("dynamics", "Dynamic")):
        assert manifest.calibrate(logical, label, 0.99) is None
        assert manifest.accept_threshold(logical)(label) is None


def test_no_accept_line_means_no_manifest():
    bad = report()
    bad["acceptLowerEdge"] = None
    with pytest.raises(ValueError, match="no accept line"):
        build(bad, "2026-10-08")
