"""
Build the detector's training set - and record why it did not exist until now.

27.45 chose detection then recognition, and only the second half got built. Every crop the
recogniser has ever been trained or measured on came from MuseScore's own SVG boxes -
ground truth. Nothing in this project yet locates a syllable on a page it has not already
been told the layout of. A page from a real scan carries no such boxes, so the recogniser as
it stands cannot be pointed at one.

This is that gap's data half: one row per box, image path, class name, and the box itself,
built from the `.boxes.json` corpus `musescore_boxes.py` already produces. It needs no
string - detection only has to find and classify a region, which is why lyric boxes and the
unpaired classes of 27.44 can train the same detector even though only lyrics carry a label
to recognise afterwards. Dynamic is included as of 27.94: 27.45 was right that it is a
music glyph, not text, and does not belong in the CTC recognizer - but that is a
recognition-stage argument, not a detection-stage one, and 27.94 found it is in fact the
most common non-Lyrics class in the corpus (5,013 boxes) once actually counted. What reads
a detected Dynamic box is a small closed-set classifier, not the syllable recogniser -
still to be built.

**Class balance is reported, not fixed here.** 27.62 measured what an imbalanced classifier
does without correction - it stops predicting the rare class - and a detector with `Lyrics`
in the thousands against `Tempo` in the tens would show the identical failure. The fix
27.62 validated (focal loss) is a property of the detector's own loss, not of this export;
recording the imbalance here is what would make that decision visible before it is trained
into a blind spot.
"""

# flake8: noqa: T201

import argparse
import collections
import json
from dataclasses import dataclass
from pathlib import Path

#: Classes the detector should learn to find. Dynamic is included as of 27.94 - it renders
#: square where every text class is wide, because MusicXML stores it as an element name
#: rather than a string, but that only means it must not be read by the CTC recognizer
#: (still true, per 27.45); finding its box is a detection-stage question, separate from
#: how it gets read afterwards, and at 5,013 boxes it is the most common non-Lyrics class
#: in the corpus.
DETECTION_CLASSES = frozenset(
    {"Lyrics", "Tempo", "StaffText", "SystemText", "Expression", "Text",
     "InstrumentName", "MeasureNumber", "RehearsalMark", "Fingering", "Harmony", "Dynamic"}
)


@dataclass(frozen=True)
class Box:
    image: str
    label: str
    left: int
    top: int
    right: int
    bottom: int


def boxes_of(record: dict, image_path: str) -> list[Box]:
    """Every detectable box in one annotated system, across all classes.

    Lyrics are stored separately from the other text classes because they alone carry a
    string (27.43's ordinal join); for detection that distinction does not matter; a box is
    a box regardless of what consumed it afterwards.
    """
    found = []
    for lyric in record.get("lyrics", []):
        found.append(
            Box(image_path, "Lyrics", lyric["left"], lyric["top"], lyric["right"], lyric["bottom"])
        )
    for label, boxes in record.get("text_boxes", {}).items():
        if label not in DETECTION_CLASSES:
            continue
        for box in boxes:
            found.append(Box(image_path, label, box["left"], box["top"], box["right"], box["bottom"]))
    return found


def collect(boxes_dir: Path) -> list[Box]:
    found = []
    for record_path in sorted(boxes_dir.glob("*/*.boxes.json")):
        record = json.loads(record_path.read_text(encoding="utf-8"))
        image_path = str(record_path.parent / record["image"])
        found.extend(boxes_of(record, image_path))
    return found


def write_manifest(boxes: list[Box], path: Path) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for box in boxes:
            handle.write(
                json.dumps(
                    {
                        "image": box.image, "label": box.label,
                        "left": box.left, "top": box.top,
                        "right": box.right, "bottom": box.bottom,
                    }
                )
                + "\n"
            )


def describe(boxes: list[Box]) -> str:
    by_class = collections.Counter(box.label for box in boxes)
    images = len({box.image for box in boxes})
    total = sum(by_class.values())

    lines = [f"{total:,} boxes across {images:,} images", "", "by class:"]
    for label, count in by_class.most_common():
        lines.append(f"  {label:<16} {count:>7,}  ({count / total:.1%})")

    if by_class:
        most, least = by_class.most_common(1)[0], by_class.most_common()[-1]
        lines += [
            "",
            f"imbalance: {most[0]} is {most[1] / max(1, least[1]):.0f}x {least[0]}",
            "  27.62 found an uncorrected classifier stops predicting a class starved this",
            "  badly; the detector's loss needs the same correction before this is trained on.",
        ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--boxes", type=Path, required=True, help="A musescore_boxes out dir.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    boxes = collect(args.boxes)
    if not boxes:
        raise SystemExit(f"No boxes found under {args.boxes}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_manifest(boxes, args.out)
    print(describe(boxes))


if __name__ == "__main__":
    main()
