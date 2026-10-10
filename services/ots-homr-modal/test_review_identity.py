import hashlib

import pytest

import review_identity
from review_identity import canonical_json, identity_sha256, review_text_identity


def test_the_identity_lists_each_component_and_its_digest_follows_its_details():
    identity = review_text_identity()
    assert identity["ocr"]["version"] == "3.9.2"
    assert set(identity["ocr"]["modelSha256"]) == {"Det", "Rec", "Cls"}
    assert all(len(v) == 64 for v in identity["ocr"]["modelSha256"].values())
    assert len(identity["semanticGate"]["modelSha256"]) == 64
    assert identity["dynamicsClassifier"]["skipMarks"] == ["p", "pp", "ppp"]
    assert set(identity["codeSha256"]) == set(review_identity.CODE_MODULES)
    assert identity["sha256"] == identity_sha256(identity)
    assert review_text_identity()["sha256"] == identity["sha256"]  # deterministic


def test_the_digest_changes_with_any_component(monkeypatch):
    base = review_text_identity()["sha256"]
    import dynamics_reader

    monkeypatch.setattr(dynamics_reader, "MIN_PROBABILITY", 0.6)
    assert review_text_identity()["sha256"] != base
    monkeypatch.undo()
    import lyric_ocr

    monkeypatch.setattr(lyric_ocr, "RAPIDOCR_VERSION", "9.9.9")
    assert review_text_identity()["sha256"] != base
    monkeypatch.undo()
    monkeypatch.setattr(review_identity, "_file_sha256", lambda name: "0" * 64 if name == "direction_text.py" else hashlib.sha256(name.encode()).hexdigest())
    assert review_text_identity()["sha256"] != base


def test_the_digest_ignores_its_own_field_and_key_order():
    a = {"b": 1, "a": {"y": [2, 1], "x": 0.5}}
    b = {"a": {"x": 0.5, "y": [2, 1]}, "b": 1, "sha256": "ignored"}
    assert identity_sha256(a) == identity_sha256(b)
    assert canonical_json(a) == '{"a":{"x":0.5,"y":[2,1]},"b":1}'
