import hashlib
from types import SimpleNamespace

import pytest
from extract_semantic_packet_ocr import ocr_inputs, recognize


def test_inference_input_strips_roles_splits_and_reference_text(tmp_path):
    crop = tmp_path / "crop.png"
    crop.write_bytes(b"pixels")
    region = {
        "id": "case",
        "crop": crop.name,
        "crop_sha256": hashlib.sha256(b"pixels").hexdigest(),
        "ground_truth_role": "Lyrics",
        "development_split": "training-candidate",
        "annotation_text": ["secret source text"],
    }
    assert set(ocr_inputs([region], tmp_path)[0]) == {"id", "crop", "crop_sha256"}
    crop.write_bytes(b"changed")
    with pytest.raises(ValueError, match="hash"):
        ocr_inputs([region], tmp_path)


def test_empty_and_failed_crops_preserved():
    item = {"id": "case", "crop": "pixels", "crop_sha256": "hash"}
    called = []

    def empty(path, **kwargs):
        called.append((path, kwargs))
        return SimpleNamespace(txts=None)

    result = recognize(empty, item)
    assert result["status"] == "empty" and result["rows"] == []
    assert called == [("pixels", {"use_det": True})]

    def failure(path, **kwargs):
        raise RuntimeError("bounded test failure")

    result = recognize(failure, item)
    assert result["status"] == "error" and result["error_type"] == "RuntimeError"
    assert result["source_text_passed_to_ocr"] is False


def test_recognized_text_confidence_and_boxes_retained():
    class Box:
        def tolist(self):
            return [[0, 0], [5, 0], [5, 3], [0, 3]]

    def engine(path, **kwargs):
        return SimpleNamespace(txts=["unprompted"], boxes=[Box()], scores=[0.8125])

    result = recognize(engine, {"id": "case", "crop": "pixels", "crop_sha256": "hash"})
    assert result["status"] == "ok"
    assert result["rows"][0]["confidence"] == 0.8125
    assert result["rows"][0]["text"] == "unprompted"
    assert result["rows"][0]["box"] == [[0, 0], [5, 0], [5, 3], [0, 3]]
