"""Turn accepted scanner lyric rows into a placement-confirmation inventory with verified note anchors.

Inputs are the review page's exported decisions (`ots.lyric-candidate-decisions.v1`), the job's
`review.staves`, the page's core MusicXML and the page image. Each ACCEPTED, UNEDITED OCR row's proposed
placement (staff, note token) is mapped onto the exact MusicXML note by aligning the token sequence with
the part's note elements; the alignment must be exact in count and rest/note kind or the part is refused.
The output feeds the existing placement-confirmation page and `import_reviewed_lyric_copy.py`; nothing is
written to a score here, and verse identity is never inferred (printed line only).
"""

import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

from reviewed_lyric_xml import anchors

Image.MAX_IMAGE_PIXELS = None
NOTE_LIKE = ("note", "rest", "gracenote")
MAX_PITCH_MISMATCH = 0.02


def sha(data):
    return hashlib.sha256(data).hexdigest()


def token_sequence(staves, part_index):
    """(staff index, token index, kind, pitch) for every note-like token of a part, in reading order."""
    out = []
    for staff in sorted((s for s in staves if s["partIndex"] == part_index), key=lambda s: s["systemIndex"]):
        for index, token in enumerate(staff["tokens"]):
            name = str(token[0])
            if name.startswith(NOTE_LIKE):
                kind = "rest" if name.startswith("rest") else "note"
                out.append((staff["index"], index, kind, str(token[1]) if kind == "note" and len(token) > 1 else None))
    return out


def xml_sequence(part):
    """(measure number, ordinal, kind, pitch) for every note element of a part, ordinals as in `anchors`."""
    out = []
    for number, measure in enumerate(part.findall("measure"), 1):
        for ordinal, note in enumerate(measure.findall("note"), 1):
            pitch = note.find("pitch")
            if pitch is None:
                out.append((number, ordinal, "rest", None))
            else:
                out.append((number, ordinal, "note", pitch.findtext("step") + pitch.findtext("octave")))
    return out


def align(tokens, notes):
    """Map (staff index, token index) -> (measure, ordinal); refuse anything but an exact alignment."""
    if len(tokens) != len(notes):
        raise ValueError(f"Token and XML note counts differ ({len(tokens)} vs {len(notes)})")
    mapping, mismatched = {}, 0
    for (staff, index, kind, pitch), (measure, ordinal, xml_kind, xml_pitch) in zip(tokens, notes):
        if kind != xml_kind:
            raise ValueError("Token and XML note/rest kinds differ")
        if kind == "note" and pitch != xml_pitch:
            mismatched += 1
        mapping[(staff, index)] = (measure, ordinal)
    if tokens and mismatched / len(tokens) > MAX_PITCH_MISMATCH:
        raise ValueError(f"Token and XML pitches differ too often ({mismatched}/{len(tokens)})")
    return mapping


def build(decisions, staves, xml_bytes, review_bytes, raster, job, page_image, out):
    if decisions.get("schemaVersion") != "ots.lyric-candidate-decisions.v1" or decisions.get("automaticAttachment") is not False:
        raise ValueError("Unsupported decisions export")
    if decisions["raster"]["checksumSha256"] != raster["checksumSha256"]:
        raise ValueError("Decisions are for a different page raster")
    root = ET.fromstring(xml_bytes)
    parts = {p.get("id"): p for p in root.findall("part")}
    lookup = anchors(root)
    mappings = {}
    skipped = {"notAccepted": 0, "editedText": 0, "noPlacement": 0, "noNote": 0, "partUnaligned": 0, "sameNote": 0}
    # One syllable per note per printed line: the writer refuses a second, and guessing a neighbouring note
    # would invent a placement. The nearest syllable keeps the note; the others are counted, not placed.
    best_for_note = {}
    for decision in decisions["decisions"]:
        placement = decision.get("proposedPlacement") if decision["state"] == "accept" else None
        for position, syllable in enumerate((placement or {}).get("syllables", [])):
            if syllable.get("noteTokenIndex") is None:
                continue
            key = (placement["staffIndex"], placement["printedLine"], syllable["noteTokenIndex"])
            distance = syllable.get("distancePx") if syllable.get("distancePx") is not None else float("inf")
            if key not in best_for_note or distance < best_for_note[key][0]:
                best_for_note[key] = (distance, decision["id"], position)
    rows = []
    scale = page_image.width and raster["width"] / page_image.width
    for decision in decisions["decisions"]:
        if decision["state"] != "accept":
            skipped["notAccepted"] += 1
            continue
        if decision.get("source") != "ocr-row" or decision["text"] != decision.get("originalOcrText"):
            skipped["editedText"] += 1  # edited text needs fresh positioning, as in the placement review
            continue
        placement = decision.get("proposedPlacement")
        if not placement:
            skipped["noPlacement"] += 1
            continue
        staff = next(s for s in staves if s["index"] == placement["staffIndex"])
        part_index = staff["partIndex"]
        if part_index not in mappings:
            part_id = f"P{part_index + 1}"
            try:
                mappings[part_index] = align(token_sequence(staves, part_index), xml_sequence(parts[part_id]))
            except (KeyError, ValueError):
                mappings[part_index] = None
        mapping = mappings[part_index]
        if mapping is None:
            skipped["partUnaligned"] += 1
            continue
        for position, syllable in enumerate(placement["syllables"]):
            token = syllable.get("noteTokenIndex")
            if token is None or (staff["index"], token) not in mapping:
                skipped["noNote"] += 1
                continue
            winner = best_for_note[(staff["index"], placement["printedLine"], token)]
            if (winner[1], winner[2]) != (decision["id"], position):
                skipped["sameNote"] += 1
                continue
            measure, ordinal = mapping[(staff["index"], token)]
            note_element, expected = lookup[(f"P{part_index + 1}", measure, ordinal)]
            identity = f"{job[:8]}:{decision['id']}:{position}"
            name = hashlib.sha256(identity.encode()).hexdigest()[:20] + ".jpg"
            region = staff["region"]
            box = decision["box"]
            x, note_x = syllable["x"] / scale, syllable["noteX"] / scale
            top, bottom = region[1] / scale, region[3] / scale
            left = max(0, min(x, note_x) - 380)
            right = min(page_image.width, max(x, note_x) + 380)
            y0 = max(0, top - 40)
            y1 = min(page_image.height, max(box[3] / scale, bottom) + 50)
            crop = page_image.crop((int(left), int(y0), int(right), int(y1))).convert("RGB")
            draw = ImageDraw.Draw(crop)
            draw.ellipse((note_x - left - 12, (top + bottom) / 2 - y0 - 12, note_x - left + 12, (top + bottom) / 2 - y0 + 12), outline="#1766ce", width=3)
            draw.rectangle((x - left - 45, box[1] / scale - y0, x - left + 45, box[3] / scale - y0), outline="#ca6c10", width=3)
            crop.save(out / name, quality=90)
            rows.append(
                {
                    "id": identity,
                    "pageSha256": raster["checksumSha256"],
                    "musicXmlSha256": sha(xml_bytes),
                    "score": f"job-{job[:8]}",
                    "text": syllable["text"],
                    "physicalRowOrder": placement["printedLine"],
                    "generatedNote": {
                        "source_part": f"P{part_index + 1}",
                        "physical_measure": measure,
                        "source_note_ordinal": ordinal,
                        **expected,
                        "lyrics": [],
                    },
                    "image": name,
                    "image_sha256": sha((out / name).read_bytes()),
                    "predictions_sha256": sha(review_bytes),
                    "verseConfirmed": False,
                    "manualTextReviewed": False,
                }
            )
    return rows, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True, help="JSON with raster {w,h} and staves")
    parser.add_argument("--raster-sha256", required=True)
    parser.add_argument("--musicxml", type=Path, required=True)
    parser.add_argument("--page-image", type=Path, required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    review_bytes = args.review.read_bytes()
    review = json.loads(review_bytes)
    raster = {"checksumSha256": args.raster_sha256, "width": review["raster"]["w"], "height": review["raster"]["h"]}
    args.out.mkdir(parents=True, exist_ok=False)
    with Image.open(args.page_image) as page:
        rows, skipped = build(
            json.loads(args.decisions.read_text()), review["staves"], args.musicxml.read_bytes(),
            review_bytes, raster, args.job, page.copy(), args.out,
        )
    (args.out / "inventory.json").write_text(json.dumps(rows, indent=2) + "\n")
    (args.out / "index.html").write_bytes(Path(__file__).with_name("lyric_placement_review.html").read_bytes())
    (args.out / "receipt.json").write_text(json.dumps({"rows": len(rows), "skipped": skipped, "musicxml_modified": False}, indent=2) + "\n")
    print(json.dumps({"rows": len(rows), "skipped": skipped}))


if __name__ == "__main__":
    main()
