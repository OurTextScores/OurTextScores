import pytest

from build_scanner_placement_inventory import align, token_sequence, xml_sequence
import xml.etree.ElementTree as ET

XML = """<score-partwise><part id="P1">
<measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
<note><rest/><duration>1</duration></note></measure>
<measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure>
</part></score-partwise>"""


def staves(order=(0, 1)):
    return [
        {"index": order[0], "partIndex": 0, "systemIndex": 0, "tokens": [["clef_G2"], ["note_4", "C4"], ["rest_4"], ["barline"]]},
        {"index": order[1], "partIndex": 0, "systemIndex": 1, "tokens": [["note_4", "D4"]]},
        {"index": 9, "partIndex": 1, "systemIndex": 0, "tokens": [["note_4", "E2"]]},
    ]


def test_tokens_align_exactly_with_xml_notes_across_systems():
    part = ET.fromstring(XML).find("part")
    mapping = align(token_sequence(staves(), 0), xml_sequence(part))
    assert mapping == {(0, 1): (1, 1), (0, 2): (1, 2), (1, 0): (2, 1)}


def test_refuses_count_kind_or_pitch_disagreement():
    part = ET.fromstring(XML).find("part")
    short = staves()
    short[1]["tokens"] = []
    with pytest.raises(ValueError, match="counts differ"):
        align(token_sequence(short, 0), xml_sequence(part))
    wrong_kind = staves()
    wrong_kind[0]["tokens"][2] = ["note_4", "G4"]
    with pytest.raises(ValueError, match="kinds differ"):
        align(token_sequence(wrong_kind, 0), xml_sequence(part))
    wrong_pitch = staves()
    wrong_pitch[1]["tokens"] = [["note_4", "A5"]]
    with pytest.raises(ValueError, match="pitches differ"):
        align(token_sequence(wrong_pitch, 0), xml_sequence(part))


def test_two_syllables_on_one_note_keep_only_the_nearest(tmp_path):
    from PIL import Image

    from build_scanner_placement_inventory import build

    xml = (
        '<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>'
        "<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>"
        "<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>"
    ).encode()
    staff = {
        "index": 0, "partIndex": 0, "systemIndex": 0, "region": [0, 100, 1000, 160],
        "tokens": [["note_4", "C4"], ["note_4", "D4"]],
    }

    def syllable(text, token, distance):
        return {"text": text, "noteTokenIndex": token, "x": 100.0, "noteX": 100.0, "distancePx": distance}

    decisions = {
        "schemaVersion": "ots.lyric-candidate-decisions.v1", "automaticAttachment": False,
        "raster": {"checksumSha256": "r"},
        "decisions": [{
            "id": "row", "text": "far near", "state": "accept", "source": "ocr-row", "originalOcrText": "far near",
            "box": [90, 170, 200, 190],
            "proposedPlacement": {"staffIndex": 0, "printedLine": 1, "syllables": [syllable("far", 0, 30.0), syllable("near", 0, 4.0)]},
        }],
    }
    rows, skipped = build(
        decisions, [staff], xml, b"{}", {"checksumSha256": "r", "width": 1000, "height": 400},
        "job12345", Image.new("RGB", (1000, 400), "white"), tmp_path,
    )
    assert [r["text"] for r in rows] == ["near"] and skipped["sameNote"] == 1
    assert rows[0]["generatedNote"]["source_part"] == "P1" and rows[0]["generatedNote"]["pitch"] == "C4"
