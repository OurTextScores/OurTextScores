"""Add bounded existing OSSQ positive directions, preserving the Lieder split/crops."""

import argparse
import hashlib
import html
import json
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw
from prepare_semantic_gt_packet import sha, stable


def select(pages, excluded):
    groups = defaultdict(lambda: defaultdict(list))
    for page in pages:
        if page["partition"] != "calibration":
            raise ValueError("Formal test pages may not enter training preparation")
        if page["corpus"] != "ossq" or page["score"] in excluded:
            continue
        for gt in page["ground_truth"]:
            if gt["semanticFamily"] == "DirectionText":
                labels = tuple(sorted({e["label"] for e in gt["evidence"]}))
                groups[page["score"]][labels].append((page, gt))
    selected = []
    for score in sorted(groups):
        queues = [
            sorted(v, key=lambda r: stable([r[0]["id"], r[1]]))
            for _, v in sorted(groups[score].items())
        ]
        for _ in range(12):
            available = [q for q in queues if q]
            if not available:
                break
            # Cycle label families to avoid using all twelve examples on one class.
            queue = available[_ % len(available)]
            selected.append(queue.pop(0))
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--base-packet", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    old = json.loads((args.base_packet / "inventory.json").read_text())
    old_receipt = json.loads((args.base_packet / "receipt.json").read_text())
    if sha(args.calibration) != old_receipt["calibration_sha256"]:
        raise ValueError("Original calibration source changed")
    pages = [json.loads(line) for line in args.calibration.read_text().splitlines()]
    excluded = set(old_receipt["excluded_scores"]) | {r["score"] for r in old}
    chosen = select(pages, excluded)
    args.out.mkdir(parents=True, exist_ok=False)
    review = args.review / "ossq-expansion-20261007"
    review.mkdir(exist_ok=False)
    inventory = list(old)
    cards = []
    verified = {}
    for page, gt in chosen:
        image_path = Path(page["image"])
        if image_path not in verified:
            if sha(image_path) != page["image_sha256"]:
                raise ValueError("Original scan changed")
            verified[image_path] = True
        for annotation in page["annotations"]:
            if sha(annotation["path"]) != annotation["sha256"]:
                raise ValueError("Positive annotation changed")
        case_id = "ossq-" + stable([page["id"], gt])[:20]
        crop, context = case_id + ".png", case_id + "-context.jpg"
        x, y, xx, yy = gt["box"]
        with Image.open(image_path) as source:
            source.crop(
                (
                    max(0, x - 12),
                    max(0, y - 12),
                    min(source.width, xx + 12),
                    min(source.height, yy + 12),
                )
            ).convert("RGB").save(review / crop)
            top = max(0, y - 160)
            band = source.crop(
                (0, top, source.width, min(source.height, yy + 160))
            ).convert("RGB")
            ImageDraw.Draw(band).rectangle(
                (x, y - top, xx, yy - top), outline="#1673bd", width=4
            )
            band.save(review / context, quality=88)
        split = (
            "internal-calibration"
            if int(
                hashlib.sha256(
                    json.dumps(
                        ["semantic-gt-v1", page["score"]], sort_keys=True
                    ).encode()
                ).hexdigest()[:8],
                16,
            )
            % 5
            == 0
            else "training-candidate"
        )
        inventory.append(
            {
                "id": case_id,
                "score": page["score"],
                "page_id": page["id"],
                "image": page["image"],
                "image_sha256": page["image_sha256"],
                "source_partition": "calibration",
                "development_split": split,
                "ground_truth_role": "DirectionText",
                "box": gt["box"],
                "evidence": gt["evidence"],
                "annotation_text": [],
                "crop": str(Path(review.name) / crop),
                "context": str(Path(review.name) / context),
                "crop_sha256": sha(review / crop),
                "context_sha256": sha(review / context),
                "scan_adjudication": "existing positive annotation; not newly adjudicated",
                "inferred_negative": False,
            }
        )
        cards.append(
            f'<article><h2>{html.escape(page["score"])} — {split}</h2><p>Existing DirectionText annotation</p><img src="{crop}"><img src="{context}"></article>'
        )
    (review / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:2rem}img{max-width:100%;max-height:350px}article{border-top:1px solid #aaa;padding:1rem}</style><h1>Existing OSSQ direction annotations</h1><p>Positive annotations only. No OCR predictions or inferred negatives; source labels pending scan adjudication. Existing Lieder review and split preserved.</p>'
        + "".join(cards)
    )
    (args.out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    receipt = {
        "calibration_sha256": sha(args.calibration),
        "base_inventory_sha256": sha(args.base_packet / "inventory.json"),
        "source_sha256": sha(__file__),
        "added_regions": len(chosen),
        "added_scores": len({p["score"] for p, g in chosen}),
        "region_counts": dict(Counter(r["ground_truth_role"] for r in inventory)),
        "new_split_counts": dict(
            Counter(r["development_split"] for r in inventory[len(old) :])
        ),
        "excluded_scores": sorted(excluded),
        "existing_inventory_prefix_unchanged": inventory[: len(old)] == old,
        "scope": "Calibration-only positive training development expansion, not independent test or complete labels",
    }
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (args.out / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
