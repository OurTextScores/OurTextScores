"""Build the human judgement page for the sampled unmatched lyric boxes (confidence hidden)."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

from lyric_calibration_sample import candidates, sample_unmatched

Image.MAX_IMAGE_PIXELS = None


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--detections", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--per-band", type=int, default=30)
    args = parser.parse_args()
    pages = []
    for path in sorted(args.detections.glob("detections-*.jsonl")):
        pages.extend(json.loads(line) for line in path.read_text().splitlines())
    rows = list(candidates(pages))
    sample = sample_unmatched(rows, per_band=args.per_band)
    # Present in a hash order so confidence bands are interleaved, not grouped.
    sample.sort(key=lambda r: hashlib.sha256(("order" + r["id"]).encode()).hexdigest())
    images = {p["id"]: p for p in pages}
    args.out.mkdir(parents=True, exist_ok=False)
    items = []
    for row in sample:
        page = images[row["page"]]
        if sha(page["image"]) != page["image_sha256"]:
            raise ValueError("Page image changed")
        x0, y0, x1, y1 = row["box"]
        with Image.open(page["image"]) as source:
            left, top = max(0, x0 - 260), max(0, y0 - 140)
            right, bottom = min(source.width, x1 + 260), min(source.height, y1 + 100)
            crop = source.crop((left, top, right, bottom)).convert("RGB")
        draw = ImageDraw.Draw(crop)
        draw.rectangle((x0 - left, y0 - top, x1 - left, y1 - top), outline="#e00000", width=3)
        name = f"{row['id']}.jpg"
        crop.save(args.out / name, quality=88)
        items.append({"id": row["id"], "image": name})
    (args.out / "items.json").write_text(json.dumps(items))
    (args.out / "index.html").write_bytes(Path(__file__).with_name("lyric_judgement_review.html").read_bytes())
    # The key (band/score/page/box) is written beside, not inside, the served directory.
    (args.out.with_name(args.out.name + "-key.json")).write_text(json.dumps(sample, indent=1))
    print(len(items), "items;", len({r["score"] for r in sample}), "scores")


if __name__ == "__main__":
    main()
