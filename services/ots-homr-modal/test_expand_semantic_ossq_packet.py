import pytest
from expand_semantic_ossq_packet import select


def page(score="sq1", partition="calibration"):
    return {
        "id": score + ":p1",
        "score": score,
        "corpus": "ossq",
        "partition": partition,
        "ground_truth": [
            {
                "semanticFamily": "DirectionText",
                "box": [i, 0, i + 1, 1],
                "evidence": [{"label": "Tempo" if i < 20 else "StaffText"}],
            }
            for i in range(30)
        ],
    }


def test_bounded_positive_sampling_respects_score_exclusions_and_label_diversity():
    rows = select([page(), page("sq2")], {"sq2"})
    assert len(rows) == 12
    assert {p["score"] for p, g in rows} == {"sq1"}
    assert {g["evidence"][0]["label"] for p, g in rows} == {"Tempo", "StaffText"}
    assert rows == select([page(), page("sq2")], {"sq2"})


def test_formal_test_input_rejected():
    with pytest.raises(ValueError, match="Formal test"):
        select([page(partition="test")], set())
