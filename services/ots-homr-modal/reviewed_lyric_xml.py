"""Apply a validated review plan to a new MusicXML copy, never overwrite inputs."""

import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
from copy import deepcopy
from fractions import Fraction
from pathlib import Path


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def anchors(root):
    result = {}
    for part in root.findall("part"):
        divisions = Fraction(1)
        for measure_index, measure in enumerate(part.findall("measure"), 1):
            cursor = previous = Fraction(0)
            ordinal = 0
            for element in measure:
                if element.tag == "attributes":
                    divisions = Fraction(element.findtext("divisions", str(divisions)))
                elif element.tag in ("backup", "forward"):
                    duration = Fraction(element.findtext("duration", "0")) / divisions
                    cursor += duration if element.tag == "forward" else -duration
                elif element.tag == "note":
                    ordinal += 1
                    duration = Fraction(element.findtext("duration", "0")) / divisions
                    chord = element.find("chord") is not None
                    onset = previous if chord else cursor
                    if not chord:
                        previous = onset
                        cursor += duration
                    pitch = element.find("pitch")
                    if pitch is None:
                        continue
                    identity = (part.get("id"), measure_index, ordinal)
                    result[identity] = (
                        element,
                        {
                            "onset_quarters": str(onset),
                            "duration_quarters": str(duration),
                            "pitch": pitch.findtext("step") + pitch.findtext("octave"),
                            "alter": pitch.findtext("alter", "0"),
                        },
                    )
    return result


def without_lyrics(root):
    copy = deepcopy(root)
    for note in copy.findall(".//note"):
        for lyric in note.findall("lyric"):
            note.remove(lyric)
    return ET.tostring(copy)


def apply_reviewed_plan(xml_bytes, plan, score):
    if (
        plan.get("schemaVersion") != "ots.lyric-placement-plan.v1"
        or plan.get("automaticAttachment") is not False
    ):
        raise ValueError("Require a validated explicit review plan")
    root = ET.fromstring(xml_bytes)
    original = without_lyrics(root)
    lookup = anchors(root)
    occupied = set()
    applied = []
    for row in plan["confirmedPlacements"]:
        if row["score"] != score:
            continue
        if row["musicXmlSha256"] != sha_bytes(xml_bytes):
            raise ValueError("Score XML identity differs")
        if (
            row.get("positionRefreshRequired")
            or row.get("excluded")
            or not all(
                row.get(k) is True
                for k in ("textConfirmed", "verseConfirmed", "noteConfirmed")
            )
        ):
            raise ValueError("Placement is not fully confirmed")
        if (
            not isinstance(row["text"], str)
            or not row["text"].strip()
            or not isinstance(row["verse"], str)
            or not row["verse"].strip()
        ):
            raise ValueError("Empty lyric text or verse")
        anchor = row["generatedNote"]
        key = (
            anchor["source_part"],
            anchor["physical_measure"],
            anchor["source_note_ordinal"],
        )
        if key not in lookup:
            raise ValueError("Unknown note anchor")
        note, expected = lookup[key]
        if any(anchor[k] != expected[k] for k in expected):
            raise ValueError("Note pitch, duration or onset differs")
        slot = (*key, row["verse"])
        if slot in occupied or any(
            l.get("number", "1") == row["verse"] for l in note.findall("lyric")
        ):
            raise ValueError("Duplicate or occupied lyric slot")
        occupied.add(slot)
        lyric = ET.SubElement(note, "lyric", number=row["verse"])
        ET.SubElement(lyric, "text").text = row["text"]
        applied.append(row["id"])
    if without_lyrics(root) != original:
        raise ValueError("Non-lyric score content changed")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), applied


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--score", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output, applied = apply_reviewed_plan(
        args.xml.read_bytes(), json.loads(args.plan.read_text()), args.score
    )
    with args.out.open("xb") as handle:
        handle.write(output)
    print(json.dumps({"applied": applied, "outputSha256": sha_bytes(output)}))
