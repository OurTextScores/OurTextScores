import json

import pytest

from semantic_gate import DEFAULT_MODEL, MODEL_SHA256, SemanticGate, normalized

TEXTS = [
    "Die Forelle.", "kind,", "a tempo.", "Revenez au 1. mouv!", "Etwas geschwind.", "star - ling gay",
    "l'oi - seau", "", "   ", "Allegro moderato", "Nun holt mir", "cresc.", "Si jé - tais", "dolce",
]


def test_load_refuses_a_different_model(tmp_path):
    other = tmp_path / "m.json"
    other.write_bytes(DEFAULT_MODEL.read_bytes() + b" ")
    with pytest.raises(ValueError, match="pinned identity"):
        SemanticGate.load(other)
    assert SemanticGate.load().threshold == 0.5 and len(MODEL_SHA256) == 64


def test_empty_text_is_unknown_and_never_proposed():
    gate = SemanticGate.load()
    assert gate.classify("")["prediction"] == "Unknown" and not gate.classify("  ")["proposedLyric"]
    assert normalized(" Ä b ") == "ä b"


def test_matches_the_numpy_reference_implementation():
    np = pytest.importorskip("numpy")
    pytest.importorskip("scipy")
    from semantic_text_pilot import predict_rows

    model = json.loads(DEFAULT_MODEL.read_text())
    gate = SemanticGate(model)
    reference = predict_rows(model, [{"id": str(i), "text": t} for i, t in enumerate(TEXTS)])
    for text, row in zip(TEXTS, reference, strict=True):
        got = gate.classify(text)
        assert got["prediction"] == row["prediction"], text
        if got["score"] is not None:
            assert abs(got["score"] - row["lyric_probability"]) < 1e-9, text
