import json
from pathlib import Path

import pytest
from semantic_external_controls import (
    coverage,
    evaluate,
    lyric_retention_gate,
    prepare,
    sha,
    union_coverage,
)


def test_union_does_not_double_count_and_keeps_frozen_area_gate():
    region = {"label": "Lyrics", "left": 0, "top": 0, "right": 20, "bottom": 20}
    assert union_coverage([0, 0, 40, 20], [region, region]) == 0.5
    assert union_coverage([0, 0, 40, 20], [dict(region, label="Tempo")]) == 0
    assert union_coverage([0, 0, 40, 20], [dict(region, right=2)]) == 0
    assert coverage([0, 0, 10, 10], [[0, 0], [5, 0], [5, 10], [0, 10]]) == 0.5


def write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


def minimal_controls(tmp_path):
    write(tmp_path / "inputs.json", [{"id": "a", "text": "scan wording"}])
    write(
        tmp_path / "evaluation.json",
        [
            {
                "id": "direction",
                "score": "s",
                "packet": "original6",
                "ground_truth_role": "DirectionText",
                "matched_ocr": [{"id": "a", "detector_e2_selected": True}],
                "ocr_miss": False,
                "detector_e2_selected": True,
                "attached_token_count_before_gate": 2,
            },
            {
                "id": "missing",
                "score": "s",
                "packet": "expanded42",
                "ground_truth_role": "Lyrics",
                "matched_ocr": [],
                "ocr_miss": True,
                "detector_e2_selected": False,
                "attached_token_count_before_gate": None,
            },
        ],
    )
    write(
        tmp_path / "receipt.json",
        {
            "inputs_sha256": sha(tmp_path / "inputs.json"),
            "evaluation_sha256": sha(tmp_path / "evaluation.json"),
        },
    )


def test_ocr_miss_and_conditional_veto_are_not_attachment_accuracy(tmp_path):
    minimal_controls(tmp_path)
    report = evaluate(
        tmp_path, [{"id": "a", "prediction": "DirectionText"}], {"frozen": True}
    )
    assert report["cases"][0]["conditional_attachment_veto"] is True
    assert report["cases"][0]["attached_token_count_before_gate"] == 2
    assert report["cases"][1]["conditional_attachment_veto"] is None
    assert report["summary"]["expanded42:Lyrics"]["ocr_misses"] == 1
    assert report["note_attachment_scored"] is False


@pytest.mark.parametrize(
    "predictions",
    [
        [],
        [{"id": "a", "prediction": "Lyrics"}, {"id": "a", "prediction": "Unknown"}],
        [{"id": "wrong", "prediction": "Lyrics"}],
    ],
)
def test_all_full_page_rows_must_be_predicted_once(tmp_path, predictions):
    minimal_controls(tmp_path)
    with pytest.raises(ValueError, match="every unique"):
        evaluate(tmp_path, predictions, {})


def test_changed_controls_rejected(tmp_path):
    minimal_controls(tmp_path)
    (tmp_path / "evaluation.json").write_text("[]")
    with pytest.raises(ValueError, match="Frozen controls changed"):
        evaluate(tmp_path, [{"id": "a", "prediction": "Lyrics"}], {})


def test_prepare_rejects_any_development_score_overlap(tmp_path):
    write(
        tmp_path / "c1-semantic-baseline-20261007/scored/report.json",
        {"cases": [{"score": "s"}]},
    )
    write(tmp_path / "c1-semantic-controls-20261005/inventory.json", [])
    write(
        tmp_path / "c1-semantic-gt-packet-20261007/inventory.json",
        [{"score": "s", "development_split": "internal-calibration"}],
    )
    with pytest.raises(ValueError, match="overlaps"):
        prepare(tmp_path, tmp_path / "output")


def test_retention_uses_unique_supplied_lyric_candidates_and_reports_ocr_misses():
    candidate = {
        "ground_truth_role": "Lyrics",
        "ocr_miss": False,
        "matched_ocr": [
            {
                "id": "a",
                "detector_e2_selected": True,
                "semantic_prediction": {"prediction": "Lyrics"},
            }
        ],
    }
    missing = {"ground_truth_role": "Lyrics", "ocr_miss": True, "matched_ocr": []}
    gate = lyric_retention_gate([candidate, candidate, missing])
    assert gate["eligible_lyric_candidates"] == 1
    assert gate["retention"] == 1
    assert gate["lyric_reference_ocr_misses"] == 1
    assert gate["all_reference_lyric_regions"] == 3
    assert gate["automatic_promotion"] is False
    assert lyric_retention_gate([missing])["passes_observed_target"] is False
