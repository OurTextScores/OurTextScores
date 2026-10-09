"""Reject stale confirmations and unsafe mappings before writing score copies."""

import json
from copy import deepcopy

import pytest
from import_corrected_lyric_copy import corrected_inventory
from import_reviewed_lyric_copy import import_copy
from reviewed_lyric_xml import sha_bytes


def evidence():
    note = {"measure": 0, "ordinal": 1, "pitch": "G4"}
    proposal = {
        "text": "du",
        "noteTokenIndex": 0,
        "notePitch": "G4",
        "measureInStaff": 0,
        "noteOrdinalInMeasure": 1,
    }
    items = [
        {
            "id": "a",
            "score": "score",
            "originalText": "Da",
            "reviewedText": "du",
            "sameNoteIdentity": True,
            "candidateNote": note,
            "originalNote": note,
            "printedLine": 2,
            "proposal": proposal,
        }
    ]
    raw = json.dumps(items).encode()
    confirmations = {
        "schemaVersion": "ots.corrected-lyric-placement-confirmations.v1",
        "automaticAttachment": False,
        "inventorySha256": sha_bytes(raw),
        "decisions": [
            {"id": "a", "reviewedText": "du", "note": note, "confirmed": True}
        ],
    }
    keys = [
        {
            "id": "a",
            "score": "score",
            "text": "Da",
            "row": "row",
            "syllable": 0,
            "staffIndex": 0,
            "printedLine": 2,
        }
    ]
    review = {
        "raster": {"w": 100, "h": 100},
        "staves": [
            {
                "index": 0,
                "partIndex": 0,
                "systemIndex": 0,
                "tokens": [["note_4", "G4"]],
            }
        ],
    }
    inventory = {
        "raster": {"width": 100, "height": 100, "checksumSha256": "page"},
        "ocrRows": [
            {
                "id": "row",
                "anchor": {
                    "staffIndex": 0,
                    "printedLine": 2,
                    "syllables": [dict(proposal, text="Da")],
                },
            }
        ],
    }
    xml = b'<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>'
    inputs = {
        "score": {
            "review": json.dumps(review).encode(),
            "inventory": json.dumps(inventory).encode(),
            "xml": xml,
        }
    }
    return raw, confirmations, keys, inputs


def test_confirmed_correction_uses_new_text_and_exact_note():
    args = evidence()
    inventory, review = corrected_inventory(*args)
    output, plan, receipt = import_copy(
        inventory, review, args[3]["score"]["xml"], "score"
    )
    assert b'<lyric number="printed-line-2"><text>du</text></lyric>' in output
    assert plan["confirmedPlacements"][0]["positionRefreshRequired"] is False
    assert receipt["allNonLyricContentUnchanged"] is True


@pytest.mark.parametrize(
    "mutation", ["hash", "text", "note", "boolean", "duplicate", "line", "xml"]
)
def test_unsafe_evidence_refused(mutation):
    raw, confirmations, keys, inputs = deepcopy(evidence())
    if mutation == "hash":
        confirmations["inventorySha256"] = "stale"
    elif mutation == "text":
        confirmations["decisions"][0]["reviewedText"] = "other"
    elif mutation == "note":
        confirmations["decisions"][0]["note"]["pitch"] = "A4"
    elif mutation == "boolean":
        confirmations["decisions"][0]["confirmed"] = "true"
    elif mutation == "duplicate":
        confirmations["decisions"].append(confirmations["decisions"][0])
    elif mutation == "line":
        keys[0]["printedLine"] = 1
    elif mutation == "xml":
        inputs["score"]["xml"] = inputs["score"]["xml"].replace(b"<step>G", b"<step>A")
    with pytest.raises(ValueError):
        corrected_inventory(raw, confirmations, keys, inputs)


def test_pending_confirmation_cannot_write():
    raw, confirmations, keys, inputs = evidence()
    confirmations["decisions"][0]["confirmed"] = False
    inventory, review = corrected_inventory(raw, confirmations, keys, inputs)
    with pytest.raises(ValueError, match="No fully confirmed"):
        import_copy(inventory, review, inputs["score"]["xml"], "score")
