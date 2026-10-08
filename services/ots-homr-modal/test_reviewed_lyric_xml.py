import xml.etree.ElementTree as ET
from copy import deepcopy

import pytest
from reviewed_lyric_xml import apply_reviewed_plan, sha_bytes, without_lyrics

XML = b'<score-partwise><part id="P1"><measure><attributes><divisions>3</divisions></attributes><note><rest/><duration>3</duration></note><note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration></note></measure></part></score-partwise>'


def plan():
    row = {
        "id": "a",
        "score": "s",
        "musicXmlSha256": sha_bytes(XML),
        "positionRefreshRequired": False,
        "textConfirmed": True,
        "verseConfirmed": True,
        "noteConfirmed": True,
        "text": "fi",
        "verse": "review-row-1",
        "generatedNote": {
            "source_part": "P1",
            "physical_measure": 1,
            "source_note_ordinal": 2,
            "onset_quarters": "1",
            "duration_quarters": "1/3",
            "pitch": "F5",
            "alter": "0",
        },
    }
    return {
        "schemaVersion": "ots.lyric-placement-plan.v1",
        "automaticAttachment": False,
        "confirmedPlacements": [row],
    }


def test_copy_preserves_all_non_lyric_content():
    output, applied = apply_reviewed_plan(XML, plan(), "s")
    assert applied == ["a"]
    assert without_lyrics(ET.fromstring(output)) == without_lyrics(ET.fromstring(XML))
    assert ET.fromstring(output).findtext(".//lyric/text") == "fi"


@pytest.mark.parametrize(
    "field,value",
    [
        ("musicXmlSha256", "stale"),
        ("positionRefreshRequired", True),
        ("noteConfirmed", False),
    ],
)
def test_unqualified_or_stale_placement_rejected(field, value):
    p = plan()
    p["confirmedPlacements"][0][field] = value
    with pytest.raises(ValueError):
        apply_reviewed_plan(XML, p, "s")


def test_wrong_anchor_and_duplicate_rejected():
    p = plan()
    p["confirmedPlacements"][0]["generatedNote"]["pitch"] = "G5"
    with pytest.raises(ValueError):
        apply_reviewed_plan(XML, p, "s")
    p = plan()
    p["confirmedPlacements"].append(deepcopy(p["confirmedPlacements"][0]))
    with pytest.raises(ValueError, match="Duplicate"):
        apply_reviewed_plan(XML, p, "s")
