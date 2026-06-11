#!/usr/bin/env python3
"""Export a Transcoda HF dataset to Gemma JSONL plus page images."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import load_from_disk


SYSTEM_PROMPT = (
    "Transcribe this full-page music image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--split", default="train")
    parser.add_argument("--image-subdir", default="images")
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_dir = Path(args.dataset_dir)
    out_dir = Path(args.out_dir)
    image_dir = out_dir / args.image_subdir / args.split
    image_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = load_from_disk(str(dataset_dir))
    total = len(ds) if not args.limit else min(len(ds), args.limit)
    jsonl_path = out_dir / f"{args.split}.jsonl"

    with jsonl_path.open("w", encoding="utf-8") as handle:
        for idx in range(total):
            row = ds[idx]
            sample_id = str(row.get("sample_id") or f"transcoda-{args.split}-{idx:06d}")
            image = row["image"].convert("RGB")
            image_name = f"{sample_id}.png"
            image_path = image_dir / image_name
            image.save(image_path)
            rel_image = f"{args.image_subdir}/{args.split}/{image_name}"
            source_ids = row.get("source_ids") or []
            record = {
                "exampleId": sample_id,
                "taskType": "transcribe_full_page",
                "system": SYSTEM_PROMPT,
                "input": {
                    "grain": "page",
                    "region": {
                        "pageIndex": 1,
                        "measureStart": None,
                        "measureEnd": None,
                    },
                    "imageRefs": {"page": rel_image, "region": rel_image},
                },
                "target": {
                    "candidate": {"content": str(row["transcription"]).strip() + "\n"},
                    "overall_confidence": 1.0,
                    "findings": [],
                    "evidence_spans": [{"pageIndex": 1, "measureStart": None, "measureEnd": None}],
                },
                "meta": {
                    "sourceIds": list(source_ids),
                    "segmentCount": row.get("segment_count"),
                    "svgSystemCount": row.get("svg_system_count"),
                    "recipeVersion": row.get("recipe_version"),
                    "transcodaDatasetDir": str(dataset_dir),
                },
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            if (idx + 1) % 1000 == 0:
                print(f"exported {idx+1}/{total}", flush=True)

    summary = {
        "dataset_dir": str(dataset_dir),
        "jsonl": str(jsonl_path),
        "images": str(image_dir),
        "rows": total,
    }
    (out_dir / f"{args.split}-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
