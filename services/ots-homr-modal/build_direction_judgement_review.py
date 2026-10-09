"""Build the human judgement page for direction/dynamic rows the scanner would offer (collect_direction_rows.py output)."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, required=True, help="pages.jsonl from collect_direction_rows.py")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    pages = [json.loads(line) for line in args.pages.read_text().splitlines()]
    args.out.mkdir(parents=True, exist_ok=False)
    items, key = [], []
    for page in pages:
        if hashlib.sha256(Path(page["image"]).read_bytes()).hexdigest() != page["imageSha256"]:
            raise ValueError("Page image changed")
        with Image.open(page["image"]) as source:
            for row in page["directionRows"]:
                x0, y0, x1, y1 = row["box"]
                digest = hashlib.sha256(f"{page['imageSha256']}:{row['box']}:{row['text']}".encode()).hexdigest()[:16]
                left, top = max(0, x0 - 260), max(0, y0 - 140)
                right, bottom = min(source.width, x1 + 260), min(source.height, y1 + 100)
                crop = source.crop((left, top, right, bottom)).convert("RGB")
                ImageDraw.Draw(crop).rectangle((x0 - left, y0 - top, x1 - left, y1 - top), outline="#e00000", width=3)
                name = f"{digest}.jpg"
                crop.save(args.out / name, quality=88)
                text = row.get("mark") or row["text"]
                items.append({"id": digest, "image": name, "kind": row["kind"], "text": text})
                key.append({"id": digest, "score": page["score"], "image": page["image"], "box": row["box"], "kind": row["kind"], "text": row["text"], "semantic": row["semantic"], "mergedFrom": row.get("mergedFrom")})
    # Present in a hash order so pages are interleaved, not grouped.
    items.sort(key=lambda i: hashlib.sha256(("order" + i["id"]).encode()).hexdigest())
    (args.out / "items.json").write_text(json.dumps(items))
    (args.out / "index.html").write_bytes(Path(__file__).with_name("direction_judgement_review.html").read_bytes())
    # The key (score/page/box) sits beside, not inside, the served directory.
    args.out.with_name(args.out.name + "-key.json").write_text(json.dumps(key, indent=1))
    print(len(items), "items;", len(pages), "pages;", len({p["score"] for p in pages}), "scores")


if __name__ == "__main__":
    main()
