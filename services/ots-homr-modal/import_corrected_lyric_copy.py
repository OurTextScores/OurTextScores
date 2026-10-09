"""Bind refreshed, owner-confirmed lyric positions to exact local MusicXML notes."""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from build_scanner_placement_inventory import align, token_sequence, xml_sequence
from import_reviewed_lyric_copy import import_copy
from reviewed_lyric_xml import anchors, sha_bytes


def corrected_inventory(items_bytes, confirmations, keys, inputs):
    items = json.loads(items_bytes)
    if (
        confirmations.get("schemaVersion")
        != "ots.corrected-lyric-placement-confirmations.v1"
        or confirmations.get("automaticAttachment") is not False
        or confirmations.get("inventorySha256") != sha_bytes(items_bytes)
    ):
        raise ValueError("Unsupported confirmation or changed corrected inventory")
    decisions = confirmations["decisions"]
    identifiers = [item["id"] for item in items]
    if (
        len(set(identifiers)) != len(identifiers)
        or len(decisions) != len(items)
        or {d["id"] for d in decisions} != set(identifiers)
    ):
        raise ValueError("Missing, duplicate or unknown confirmation")
    decisions = {d["id"]: d for d in decisions}
    keys = {k["id"]: k for k in keys}
    rows, reviewed = [], []
    for item in items:
        decision, key = decisions[item["id"]], keys[item["id"]]
        if (
            type(decision["confirmed"]) is not bool
            or decision["reviewedText"] != item["reviewedText"]
            or decision["note"] != item["candidateNote"]
            or not item["sameNoteIdentity"]
            or item["candidateNote"] != item["originalNote"]
            or not isinstance(item["reviewedText"], str)
            or not item["reviewedText"].strip()
        ):
            raise ValueError("Confirmation text or note identity differs")
        score = item["score"]
        if score != key["score"] or item["originalText"] != key["text"]:
            raise ValueError("Original reviewed item differs")
        source = inputs[score]
        review = json.loads(source["review"])
        inventory = json.loads(source["inventory"])
        if (
            review["raster"]["w"] != inventory["raster"]["width"]
            or review["raster"]["h"] != inventory["raster"]["height"]
        ):
            raise ValueError("Raster dimensions differ")
        original = next(r for r in inventory["ocrRows"] if r["id"] == key["row"])
        anchor = original["anchor"]
        syllable = anchor["syllables"][key["syllable"]]
        expected_note = {
            "measure": syllable["measureInStaff"],
            "ordinal": syllable["noteOrdinalInMeasure"],
            "pitch": syllable["notePitch"],
        }
        line = item["printedLine"]
        if (
            expected_note != item["originalNote"]
            or syllable["text"] != item["originalText"]
            or anchor["staffIndex"] != key["staffIndex"]
            or type(line) is not int
            or line < 1
            or line != key["printedLine"]
            or line != anchor["printedLine"]
        ):
            raise ValueError("Frozen staff, lyric line or note differs")
        proposal = item["proposal"]
        if (
            proposal["noteTokenIndex"] != syllable["noteTokenIndex"]
            or proposal["notePitch"] != expected_note["pitch"]
            or proposal["measureInStaff"] != expected_note["measure"]
            or proposal["noteOrdinalInMeasure"] != expected_note["ordinal"]
            or proposal["text"] != item["reviewedText"]
        ):
            raise ValueError("Refreshed proposal differs from confirmed note")
        staff = next(s for s in review["staves"] if s["index"] == key["staffIndex"])
        part_id = f"P{staff['partIndex'] + 1}"
        root = ET.fromstring(source["xml"])
        part = root.find(f"part[@id='{part_id}']")
        if part is None:
            raise ValueError("Decoded part missing in MusicXML")
        mapping = align(
            token_sequence(review["staves"], staff["partIndex"]), xml_sequence(part)
        )
        measure, ordinal = mapping[(staff["index"], proposal["noteTokenIndex"])]
        _, note = anchors(root)[(part_id, measure, ordinal)]
        if note["pitch"] != expected_note["pitch"]:
            raise ValueError("Selected MusicXML pitch differs")
        row = {
            "id": item["id"],
            "score": score,
            "text": item["reviewedText"],
            "physicalRowOrder": line,
            "pageSha256": inventory["raster"]["checksumSha256"],
            "musicXmlSha256": sha_bytes(source["xml"]),
            "predictions_sha256": sha_bytes(source["review"]),
            "generatedNote": {
                "source_part": part_id,
                "physical_measure": measure,
                "source_note_ordinal": ordinal,
                **note,
            },
        }
        rows.append(row)
        reviewed.append(
            dict(
                row,
                printedLine=line,
                textConfirmed=decision["confirmed"],
                verseConfirmed=decision["confirmed"],
                noteConfirmed=decision["confirmed"],
                excluded=False,
            )
        )
    return rows, {
        "schemaVersion": "ots.lyric-placement-decisions.v2",
        "automaticAttachment": False,
        "decisions": reviewed,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    folder = (
        args.base / "guarded-tuplet-20261004/review/lyric-corrected-syllables-20261008"
    )
    hashes = {}

    def read(path):
        data = path.read_bytes()
        hashes[str(path.relative_to(args.base))] = sha_bytes(data)
        return data

    items_bytes = read(folder / "items.json")
    confirmations = json.loads(read(folder / "owner-confirmations.json"))
    keys = json.loads(
        read(
            args.base
            / "guarded-tuplet-20261004/review/lyric-anchor-judgement-2-20261008-key.json"
        )
    )
    inputs = {}
    for score in {i["score"] for i in json.loads(items_bytes)}:
        saved = args.base / "lyric-fresh2-upload-audit-20261008/saved-fresh2-inputs"
        inputs[score] = {
            "review": read(saved / f"review-{score}.json"),
            "inventory": read(saved / f"inventory-{score}.json"),
            "xml": read(
                args.base / "lyric-corrected-copy-inputs-20261008" / f"{score}.musicxml"
            ),
        }
    inventory, review = corrected_inventory(items_bytes, confirmations, keys, inputs)
    outputs = {
        score: import_copy(inventory, review, source["xml"], score)
        for score, source in inputs.items()
    }
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    (args.out / "validated-review.json").write_text(json.dumps(review, indent=2) + "\n")
    receipts = {}
    for score, (xml, plan, receipt) in outputs.items():
        target = args.out / score
        target.mkdir()
        (target / "score.musicxml").write_bytes(xml)
        (target / "validated-plan.json").write_text(json.dumps(plan, indent=2) + "\n")
        (target / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        receipts[score] = receipt
    (args.out / "receipt.json").write_text(
        json.dumps(
            {
                "inputSha256": hashes,
                "sourceSha256": sha_bytes(Path(__file__).read_bytes()),
                "automaticAttachment": False,
                "scores": receipts,
                "scope": "Selected owner-confirmed corrections; original files unchanged, printed line labels only, no qualification claim.",
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps({score: receipt["applied"] for score, receipt in receipts.items()})
    )


if __name__ == "__main__":
    main()
