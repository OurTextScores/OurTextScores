import pytest
from import_reviewed_lyric_copy import import_copy
from test_reviewed_lyric_xml import XML, plan


def inputs():
    row = plan()["confirmedPlacements"][0]
    row.update(pageSha256="p", predictions_sha256="z", physicalRowOrder=1)
    review = dict(row, printedLine=1, excluded=False)
    del review["verse"]
    return [row], {
        "schemaVersion": "ots.lyric-placement-decisions.v2",
        "automaticAttachment": False,
        "decisions": [review],
    }


def test_visible_line_maps_to_stable_export_label_and_copied_score():
    inventory, review = inputs()
    output, validated, receipt = import_copy(inventory, review, XML, "s")
    assert b'number="printed-line-1"' in output
    assert validated["confirmedPlacements"][0]["verse"] == "printed-line-1"
    assert "verse" not in review["decisions"][0]
    assert receipt["applied"] == ["a"]


@pytest.mark.parametrize("line", [None, 2, True, "1"])
def test_missing_or_unknown_visible_line_rejected(line):
    inventory, review = inputs()
    review["decisions"][0]["printedLine"] = line
    with pytest.raises(ValueError):
        import_copy(inventory, review, XML, "s")


def test_pending_review_cannot_create_a_copy():
    inventory, review = inputs()
    review["decisions"][0]["noteConfirmed"] = False
    with pytest.raises(ValueError, match="No fully"):
        import_copy(inventory, review, XML, "s")
