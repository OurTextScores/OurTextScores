import json

from calibration_manifest import load_calibration_manifest
from make_local_test_fusion_manifest import build
from pins import DETECTORS, FUSION_DETECTORS


def test_manifest_loads_pins_every_logical_detector_and_never_accepts(tmp_path):
    path = tmp_path / "m.json"
    path.write_text(json.dumps(build(), indent=1, sort_keys=True))
    manifest = load_calibration_manifest(path)
    assert manifest.policy == "fusion-v1"
    assert set(manifest.detectors) == set(FUSION_DETECTORS)
    lyrics = DETECTORS["lyrics"]
    manifest.assert_detector_matches("lyrics", sha256=lyrics[3], revision=lyrics[1])
    assert manifest.calibrate("lyrics", "Lyrics", 0.99) is None
    assert manifest.accept_threshold("lyrics")("Lyrics") is None
