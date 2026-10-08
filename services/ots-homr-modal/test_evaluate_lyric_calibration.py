import json

from build_fusion_v1_manifest import build
from calibration_manifest import load_calibration_manifest
from evaluate_lyric_calibration import evaluate


def manifest(tmp_path):
    report = {
        "schemaVersion": "ots.lyric-calibration-fit.v1", "targetPrecision": 0.9, "acceptLowerEdge": 0.6,
        "bands": [{"lowerEdge": e, "calibrated": c} for e, c in zip([0.5, 0.6, 0.7, 0.8, 0.9], [0.7, 0.93, 0.93, 0.93, 0.98])],
        "pages": {}, "negativeRates": [], "caveats": [], "acceptChoice": {"rule": "t"}, "definition": "d", "tallBoxProxy": {},
        "sizeGate": {"minBoxArea": {"Lyrics": 200}, "maxPageAreaFraction": 0.25},
    }
    path = tmp_path / "m.json"
    path.write_text(json.dumps(build(report, "2026-10-08"), indent=1, sort_keys=True))
    return load_calibration_manifest(path)


def box(conf, cov=0.0, neg=False, area=1000):
    return {"box": [0, 0, 10, 100], "rawConfidence": conf, "knownCoverage": cov, "verifiedNegative": neg, "area": area}


def test_gate_threshold_and_bounds(tmp_path):
    pages = [
        {"id": "v", "score": "s", "corpus": "lieder", "boxes": [box(0.95, 1.0), box(0.7), box(0.55, 1.0), box(0.9, 1.0, area=50)]},
        {"id": "o", "score": "o", "corpus": "ossq", "boxes": [box(0.8, neg=True), box(0.55, neg=True)]},
    ]
    result = evaluate(pages, manifest(tmp_path), 0.5)
    assert result["acceptedVocalBoxes"] == 2  # 0.55 below the line, area-50 box gated out
    assert (result["matched"], result["unmatched"]) == (1, 1)
    assert result["matchedShare"] == 0.5 and result["projectedPrecision"] == 0.75
    assert result["instrumentalFalsePositives"] == 1 and result["falsePositivesPerInstrumentalPage"] == 1.0
