import copy

import pytest
from shard_semantic_packet_ocr import merge_predictions


def records():
    inputs = [
        {"id": str(i), "crop": f"{i}.png", "crop_sha256": str(i)} for i in range(3)
    ]
    results = [
        {**r, "status": "empty", "rows": [], "source_text_passed_to_ocr": False}
        for r in inputs
    ]
    return inputs, results


def test_resume_and_shards_merge_in_frozen_order_without_mutation():
    inputs, results = records()
    before = copy.deepcopy(results)
    assert (
        merge_predictions(inputs, [[results[1]], [results[2]], [results[0]]]) == results
    )
    assert results == before


def test_duplicates_missing_changed_inputs_and_leakage_rejected():
    inputs, results = records()
    for groups in ([[results[0]], results], [results[:-1]]):
        with pytest.raises(ValueError):
            merge_predictions(inputs, groups)
    results[0]["crop_sha256"] = "tampered"
    with pytest.raises(ValueError, match="mismatch"):
        merge_predictions(inputs, [results])
    inputs, results = records()
    results[0]["source_text_passed_to_ocr"] = True
    with pytest.raises(ValueError, match="leakage"):
        merge_predictions(inputs, [results])
