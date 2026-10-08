"""Freeze an annotation-only, score-disjoint semantic development review packet.

This uses existing positive annotations, never inferred negatives or model output.
Internal development splits are not formal held-out qualification sets.
"""

import argparse
import hashlib
import html
import json
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stable(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def select_regions(pages, audit):
    if any(p["partition"] != "calibration" for p in pages):
        raise ValueError(
            "Only original calibration pages may enter this development packet"
        )
    excluded = set(audit["excluded_scores"])
    ids = set(audit["selected_page_ids"])
    eligible = [p for p in pages if p["id"] in ids]
    if len(eligible) != audit["candidate_pages"] or any(
        p["corpus"] != "lieder" or p["score"] in excluded for p in eligible
    ):
        raise ValueError("Eligible membership differs from the frozen pool audit")
    lyrics, selected = defaultdict(list), []
    for page in eligible:
        for gt in page["ground_truth"]:
            family = gt["semanticFamily"]
            record = {"page": page, "ground_truth": gt}
            if family == "Lyrics":
                lyrics[page["score"]].append(record)
            elif family == "DirectionText" or family in (
                "Title",
                "Credit",
                "OtherText",
            ):
                selected.append(record)
    for score in sorted(lyrics):
        selected.extend(
            sorted(
                lyrics[score],
                key=lambda r: stable([r["page"]["id"], r["ground_truth"]]),
            )[:2]
        )
    selected.sort(
        key=lambda r: (r["page"]["score"], r["page"]["id"], stable(r["ground_truth"]))
    )
    splits = {
        s: (
            "internal-calibration"
            if int(stable(["semantic-gt-v1", s])[:8], 16) % 5 == 0
            else "training-candidate"
        )
        for s in {r["page"]["score"] for r in selected}
    }
    for record in selected:
        record["split"] = splits[record["page"]["score"]]
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--pool-audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    args = parser.parse_args()
    audit = json.loads(args.pool_audit.read_text())
    if sha(args.calibration) != audit["calibration_sha256"]:
        raise ValueError("Calibration input hash changed")
    pages = [json.loads(line) for line in args.calibration.read_text().splitlines()]
    selected = select_regions(pages, audit)
    args.out.mkdir(parents=True, exist_ok=False)
    args.review.mkdir(parents=True, exist_ok=False)
    inventory, cards, checked = [], [], {}
    by_page = defaultdict(list)
    for record in selected:
        by_page[record["page"]["id"]].append(record)
    for page_id, records in by_page.items():
        page = records[0]["page"]
        if sha(page["image"]) != page["image_sha256"]:
            raise ValueError("Original scan changed")
        for annotation in page["annotations"]:
            path = annotation["path"]
            checked.setdefault(path, sha(path))
            if checked[path] != annotation["sha256"]:
                raise ValueError("Ground-truth annotation changed")
        with Image.open(page["image"]) as source:
            image = source.convert("RGB")
        for record in records:
            gt = record["ground_truth"]
            x, y, xx, yy = gt["box"]
            if not (0 <= x < xx <= image.width and 0 <= y < yy <= image.height):
                raise ValueError("Annotation box outside original image")
            case_id = page["score"] + "-" + stable([page_id, gt])[:12]
            crop, context = case_id + "-crop.png", case_id + "-context.jpg"
            image.crop(
                (
                    max(0, x - 15),
                    max(0, y - 12),
                    min(image.width, xx + 15),
                    min(image.height, yy + 12),
                )
            ).save(args.review / crop)
            top = max(0, y - 180)
            band = image.crop((0, top, image.width, min(image.height, yy + 180)))
            ImageDraw.Draw(band).rectangle(
                (x, y - top, xx, yy - top), outline="#1673bd", width=4
            )
            band.save(args.review / context, quality=88)
            texts = [e["text"] for e in gt["evidence"] if e.get("text")]
            item = {
                "id": case_id,
                "score": page["score"],
                "page_id": page_id,
                "image": page["image"],
                "image_sha256": page["image_sha256"],
                "source_partition": page["partition"],
                "development_split": record["split"],
                "ground_truth_role": gt["semanticFamily"],
                "box": gt["box"],
                "evidence": gt["evidence"],
                "annotation_text": texts,
                "crop": crop,
                "context": context,
                "crop_sha256": sha(args.review / crop),
                "context_sha256": sha(args.review / context),
                "scan_adjudication": "pending; existing annotation positive only",
                "inferred_negative": False,
            }
            inventory.append(item)
            esc = html.escape
            cards.append(
                f"<article data-role='{esc(item['ground_truth_role'])}'><h2>{esc(item['ground_truth_role'])}: {esc(' / '.join(texts))}</h2><p>{esc(item['score'])} — {esc(Path(item['image']).name)} — {esc(item['development_split'])}</p><p>Existing score-matched annotation; original-scan verification pending.</p><img class='tight' src='{crop}' alt='Annotated text crop'><img src='{context}' alt='Original scan context with annotated region boxed'></article>"
            )
    counts = Counter(r["ground_truth_role"] for r in inventory)
    if counts["DirectionText"] != audit["positive_regions"]["DirectionText"]:
        raise ValueError("Not all audited direction positives retained")
    receipt = {
        "calibration": str(args.calibration.resolve()),
        "calibration_sha256": sha(args.calibration),
        "pool_audit": str(args.pool_audit.resolve()),
        "pool_audit_sha256": sha(args.pool_audit),
        "script_sha256": sha(__file__),
        "excluded_scores": audit["excluded_scores"],
        "selected_page_ids": sorted(by_page),
        "region_counts": counts,
        "score_count": len({r["score"] for r in inventory}),
        "page_count": len(by_page),
        "split_counts": {
            split: {
                "regions": sum(r["development_split"] == split for r in inventory),
                "scores": len(
                    {r["score"] for r in inventory if r["development_split"] == split}
                ),
                "roles": Counter(
                    r["ground_truth_role"]
                    for r in inventory
                    if r["development_split"] == split
                ),
            }
            for split in ("training-candidate", "internal-calibration")
        },
        "annotation_sha256": checked,
        "missing_coverage": [
            "No explicitly annotated title/credit/other positives in eligible pool"
        ],
        "limitations": [
            "Positive-only score-matched annotations are not complete semantic labels or native note-attachment truth",
            "No unannotated text converted to negatives; Dynamic glyphs excluded",
            "No OSSQ examples in this Lieder pool; OSSQ non-lyric control coverage remains open",
            "Development score splits only; formal test unread; no classifier trained; no promotion threshold",
            "Prior C1 calibration and qualification exclusions preserved verbatim",
        ],
    }
    for name, value in (("inventory.json", inventory), ("receipt.json", receipt)):
        payload = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        (args.out / name).write_text(payload)
        (args.review / name).write_text(payload)
    (args.review / "index.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>C1 ground-truth development packet</title><style>body{font:16px system-ui;max-width:1200px;margin:30px auto;background:#eee}article{background:white;padding:20px;margin:20px 0}img{display:block;max-width:100%;margin:15px 0}.tight{max-height:160px;width:auto}</style><h1>C1 semantic ground-truth development packet</h1><p>Existing annotation positives only; scan adjudication pending. No classifier predictions or inferred negative labels. Score-disjoint development splits; prior review/qualification scores excluded.</p><p>"
        + html.escape(json.dumps(dict(counts)))
        + "</p><p>Missing: complete title/credit class and OSSQ non-lyric controls. Dynamics excluded.</p>"
        + "".join(cards)
    )
    print(
        json.dumps(
            {
                "regions": len(inventory),
                "roles": counts,
                "pages": len(by_page),
                "scores": receipt["score_count"],
                "review": str(args.review),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
