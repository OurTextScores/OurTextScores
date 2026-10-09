import json
from pathlib import Path

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from direction_text import merge_classifier_rows
from dynamics_reader import WEIGHTS, WEIGHTS_SHA256, DynamicsReader, build_model, iou


def box(left, top, right, bottom, label="Dynamic"):
    return {"label": label, "left": left, "top": top, "right": right, "bottom": bottom, "confidence": 0.9}


def test_the_pinned_weights_load_and_have_the_expected_labels():
    reader = DynamicsReader()
    assert reader.labels[0] == "f" or "none" in reader.labels
    assert {"p", "pp", "mf", "f", "ff", "none"} <= set(reader.labels)
    assert WEIGHTS.exists() and len(WEIGHTS_SHA256) == 64


def test_changed_weights_are_refused(tmp_path):
    other = tmp_path / "w.pth"
    other.write_bytes(WEIGHTS.read_bytes() + b"x")
    with pytest.raises(RuntimeError, match="pinned identity"):
        DynamicsReader(other)


def test_reading_skips_non_dynamic_tiny_and_blank_boxes_and_returns_marks_only(tmp_path):
    reader = DynamicsReader()
    page = np.full((300, 400, 3), 255, np.uint8)
    boxes = [box(10, 10, 60, 50), box(10, 10, 12, 12), box(100, 100, 150, 140, label="Lyrics")]
    rows = reader.read(page, boxes)
    # A blank page region is not a mark: whatever is returned must be a labelled mark above the threshold.
    assert all(r["kind"] == "dynamic" and r["source"] == "classifier" and r["mark"] == r["text"] and r["mark"] != "none" for r in rows)
    assert reader.read(page, []) == []


def test_boxes_below_the_mark_size_floor_are_not_classified(monkeypatch):
    reader = DynamicsReader()
    monkeypatch.setattr(reader, "labels", ["f", "none"])

    class Always:
        def __call__(self, images):
            return torch.tensor([[5.0, 0.0]] * images.shape[0])

    reader.model = Always()
    wide = np.zeros((400, 1920, 3), np.uint8)
    # 22x12 = 264 px (a beam stub) is under the 400 px floor at 1920 wide; 30x30 is over it.
    assert [r["box"] for r in reader.read(wide, [box(10, 10, 32, 22), box(100, 100, 130, 130)])] == [[100, 100, 130, 130]]
    # A page half as wide scales the floor down by four: 22x12 is then large enough.
    narrow = np.zeros((200, 960, 3), np.uint8)
    assert len(reader.read(narrow, [box(10, 10, 32, 22)])) == 1


def test_a_trained_model_layout_matches_the_weights(tmp_path):
    reader = DynamicsReader()
    fresh = build_model(len(reader.labels))
    assert set(fresh.state_dict()) == set(reader.model.state_dict())


def test_overlapping_boxes_keep_only_the_strongest(monkeypatch):
    reader = DynamicsReader()
    monkeypatch.setattr(reader, "labels", ["f", "none"])

    class Fake:
        def __call__(self, images):
            n = images.shape[0]
            return torch.tensor([[3.0, 0.0]] + [[2.0, 0.0]] * (n - 1))

    reader.model = Fake()
    page = np.zeros((200, 200, 3), np.uint8)
    rows = reader.read(page, [box(10, 10, 60, 50), box(12, 12, 62, 52), box(120, 120, 170, 160)])
    assert [r["box"] for r in rows] == [[10, 10, 60, 50], [120, 120, 170, 160]]


def test_merge_drops_classifier_rows_over_any_ocr_row_and_tags_sources():
    ocr = [{"box": [100, 100, 130, 130], "text": "p", "kind": "dynamic", "mark": "p"}]
    classifier = [
        {"box": [102, 102, 131, 131], "text": "pp", "kind": "dynamic", "mark": "pp", "source": "classifier"},
        {"box": [300, 300, 330, 330], "text": "f", "kind": "dynamic", "mark": "f", "source": "classifier"},
        {"box": [500, 500, 530, 530], "text": "mf", "kind": "dynamic", "mark": "mf", "source": "classifier"},
    ]
    merged = merge_classifier_rows(ocr, classifier, [[100, 100, 130, 130], [490, 495, 540, 540]])
    assert [(r["text"], r["source"]) for r in merged] == [("p", "ocr"), ("f", "classifier")]


def test_iou():
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
