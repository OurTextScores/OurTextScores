import hashlib
import json

import pytest
from score_anchor_judgements import score_review


def inputs():
    items = [{"id": str(i)} for i in range(3)]
    key = [dict(row, score="s") for row in items]
    review = {
        "schemaVersion": "ots.lyric-anchor-judgements.v1",
        "itemsSha256": hashlib.sha256(
            json.dumps(["0", "1", "2"], separators=(",", ":")).encode()
        ).hexdigest(),
        "judgements": {"0": "correct", "1": "unsure", "2": "wrong"},
    }
    return items, key, review


def test_unsure_is_wrong_and_inventory_is_bound():
    items, key, review = inputs()
    result = score_review(items, key, review)
    assert result["unsureTreatedAsWrong"]["wrong"] == 2
    assert result["unsureTreatedAsWrong"]["accuracy"] == 1 / 3
    review["itemsSha256"] = "stale"
    with pytest.raises(ValueError):
        score_review(items, key, review)


def test_incomplete_review_refused():
    items, key, review = inputs()
    del review["judgements"]["1"]
    with pytest.raises(ValueError):
        score_review(items, key, review)


def test_explicit_correction_is_preserved_without_approving_note_placement():
    items, key, review = inputs()
    key[0]["text"] = "pourton"
    review["syllableCorrections"] = {
        "0": {"originalText": "pourton", "correctedText": "ton"}
    }
    row = score_review(items, key, review)["reviewedSyllableCorrections"][0]
    assert row["correctedText"] == "ton"
    assert row["positionRefreshRequired"]
    assert row["notePlacementConfirmed"] is False


@pytest.mark.parametrize(
    "correction",
    [
        {"originalText": "forged", "correctedText": "ton"},
        {"originalText": "pourton", "correctedText": ""},
    ],
)
def test_stale_or_empty_correction_refused(correction):
    items, key, review = inputs()
    key[0]["text"] = "pourton"
    review["syllableCorrections"] = {"0": correction}
    with pytest.raises(ValueError):
        score_review(items, key, review)
