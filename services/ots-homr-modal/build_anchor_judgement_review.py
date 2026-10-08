"""Build the judgement page for proposed lyric placements on fresh pages (no confirmations used).

Reads each job's lyric candidate inventory (OCR rows with anchors) saved as `inventory-<score>.json`
plus the original page image. One item per anchored syllable of a proposed lyric row, sampled stably
(<= --per-page per page). The image marks the syllable (orange) and the proposed note's x (blue).
"""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def items_for(score, inventory, scale):
    for row in inventory["ocrRows"]:
        anchor = row.get("anchor")
        if not anchor or not row["proposedLyric"]:
            continue
        for index, syllable in enumerate(anchor["syllables"]):
            if syllable.get("noteX") is None:
                continue
            yield {
                "score": score,
                "row": row["id"],
                "syllable": index,
                "text": syllable["text"],
                "x": syllable["x"] / scale,
                "noteX": syllable["noteX"] / scale,
                "box": [c / scale for c in row["box"]],
                "staffIndex": anchor["staffIndex"],
                "printedLine": anchor["printedLine"],
                "measureInStaff": syllable["measureInStaff"],
                "noteOrdinal": syllable["noteOrdinalInMeasure"],
                "notePitch": syllable["notePitch"],
                "position": syllable["position"],
                "distancePx": (
                    syllable["distancePx"] / scale
                    if syllable.get("distancePx") is not None
                    else None
                ),
            }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work",
        type=Path,
        required=True,
        help="dir with inventory-<score>.json, review-<score>.json",
    )
    parser.add_argument(
        "--pages", type=Path, required=True, help="lines: <score> <image path>"
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--per-page", type=int, default=10)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    chosen, items = [], []
    for line in args.pages.read_text().splitlines():
        score, image_path = line.split(" ", 1)
        inventory_path = args.work / f"inventory-{score}.json"
        if not inventory_path.exists():
            continue
        inventory = json.loads(inventory_path.read_text())
        review = json.loads((args.work / f"review-{score}.json").read_text())
        with Image.open(image_path) as source:
            width, height = source.size
            scale = review["raster"]["w"] / width  # raster px per original px
            rows = sorted(
                items_for(score, inventory, scale),
                key=lambda r: hashlib.sha256(
                    f"{score}:{r['row']}:{r['syllable']}".encode()
                ).hexdigest(),
            )[: args.per_page]
            staves = {s["index"]: s for s in review["staves"]}
            for item in rows:
                staff = staves[item["staffIndex"]]
                top = staff["region"][1] / scale
                bottom = staff["region"][3] / scale
                left = max(0, min(item["x"], item["noteX"]) - 380)
                right = min(width, max(item["x"], item["noteX"]) + 380)
                y0 = max(0, top - 40)
                y1 = min(height, max(item["box"][3], bottom) + 50)
                crop = source.crop((int(left), int(y0), int(right), int(y1))).convert(
                    "RGB"
                )
                draw = ImageDraw.Draw(crop)
                bx = item["box"]
                # The outline is the complete OCR row. A narrow tick marks the
                # proportional syllable estimate; never present it as a glyph box.
                draw.rectangle(
                    (bx[0] - left, bx[1] - y0, bx[2] - left, bx[3] - y0),
                    outline="#888888",
                    width=1,
                )
                draw.line(
                    (item["x"] - left, bx[1] - y0, item["x"] - left, bx[3] - y0),
                    fill="#cc6600",
                    width=3,
                )
                draw.line(
                    (item["noteX"] - left, top - y0, item["noteX"] - left, bottom - y0),
                    fill="#1177cc",
                    width=3,
                )
                item["id"] = hashlib.sha256(
                    f"{score}:{item['row']}:{item['syllable']}".encode()
                ).hexdigest()[:20]
                name = f"{item['id']}.jpg"
                crop.save(args.out / name, quality=88)
                items.append(
                    {
                        "id": item["id"],
                        "image": name,
                        "text": item["text"],
                        "notePitch": item["notePitch"],
                        "position": item["position"],
                    }
                )
                chosen.append(item)
    order = lambda i: hashlib.sha256(("order" + i["id"]).encode()).hexdigest()
    items.sort(key=order)
    (args.out / "items.json").write_text(json.dumps(items))
    (args.out / "index.html").write_bytes(
        Path(__file__).with_name("lyric_anchor_review.html").read_bytes()
    )
    args.out.with_name(args.out.name + "-key.json").write_text(
        json.dumps(chosen, indent=1)
    )
    print(len(items), "items across", len({c["score"] for c in chosen}), "pages")


if __name__ == "__main__":
    main()
