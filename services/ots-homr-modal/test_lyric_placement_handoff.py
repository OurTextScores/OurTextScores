from copy import deepcopy

import pytest
from lyric_placement_handoff import placement_handoff


def fixture():
    row = {
        "id": "a",
        "score": "s",
        "pageSha256": "p",
        "musicXmlSha256": "x",
        "generatedNote": {"physical_measure": 4},
        "predictions_sha256": "z",
        "text": "dreams",
    }
    decision = dict(
        row,
        verse="second verse",
        textConfirmed=True,
        verseConfirmed=True,
        noteConfirmed=True,
        excluded=False,
    )
    return [row], {
        "schemaVersion": "ots.lyric-placement-decisions.v1",
        "automaticAttachment": False,
        "decisions": [decision],
    }


def test_explicit_verse_and_anchor_required():
    inventory, review = fixture()
    result = placement_handoff(inventory, review)
    assert result["confirmedPlacements"][0]["verse"] == "second verse"
    assert result["musicXmlModified"] is False
    review["decisions"][0]["verseConfirmed"] = False
    assert not placement_handoff(inventory, review)["confirmedPlacements"]


@pytest.mark.parametrize(
    "field", ["pageSha256", "musicXmlSha256", "generatedNote", "predictions_sha256"]
)
def test_stale_evidence_rejected(field):
    inventory, review = fixture()
    review["decisions"][0][field] = "forged"
    with pytest.raises(ValueError):
        placement_handoff(inventory, review)


def test_edits_require_new_geometry_and_duplicates_rejected():
    inventory, review = fixture()
    review["decisions"][0]["text"] = "different"
    with pytest.raises(ValueError):
        placement_handoff(inventory, review)
    review["decisions"][0]["noteConfirmed"] = False
    assert placement_handoff(inventory, review)["pendingPlacements"][0][
        "positionRefreshRequired"
    ]
    review["decisions"].append(deepcopy(review["decisions"][0]))
    with pytest.raises(ValueError):
        placement_handoff(inventory, review)
