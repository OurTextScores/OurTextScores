#!/usr/bin/env python3
"""Export Transcoda resumable Arrow shards to Gemma JSONL plus page images."""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from datasets import Dataset


SYSTEM_PROMPT = (
    "Transcribe this full-page music image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--split", default="train")
    parser.add_argument("--image-subdir", default="images")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=1)
    return parser.parse_args()


def export_shard(payload: tuple[str, str, str, str, int]) -> tuple[int, list[str]]:
    shard, out_dir, image_subdir, split, shard_index = payload
    shard_path = Path(shard)
    image_dir = Path(out_dir) / image_subdir / split
    ds = Dataset.from_file(str(shard_path))

    records: list[str] = []
    for row_index, row in enumerate(ds):
        fallback_id = f"transcoda-{split}-{shard_index:06d}-{row_index:03d}"
        sample_id = str(row.get("sample_id") or fallback_id)
        image = row["image"].convert("RGB")
        image_name = f"{sample_id}.png"
        image_path = image_dir / image_name
        image.save(image_path)
        rel_image = f"{image_subdir}/{split}/{image_name}"
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
                "evidence_spans": [
                    {"pageIndex": 1, "measureStart": None, "measureEnd": None}
                ],
            },
            "meta": {
                "sourceIds": list(source_ids),
                "segmentCount": row.get("segment_count"),
                "svgSystemCount": row.get("svg_system_count"),
                "recipeVersion": row.get("recipe_version"),
                "transcodaShard": str(shard_path),
            },
        }
        records.append(json.dumps(record, ensure_ascii=False))
    return shard_index, records


def main() -> None:
    args = parse_args()
    shards_dir = Path(args.shards_dir)
    out_dir = Path(args.out_dir)
    image_dir = out_dir / args.image_subdir / args.split
    image_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    shard_paths = sorted(shards_dir.glob("*.arrow"))
    if args.limit:
        shard_paths = shard_paths[: args.limit]
    if not shard_paths:
        raise SystemExit(f"No .arrow shards found under {shards_dir}")

    jsonl_path = out_dir / f"{args.split}.jsonl"
    tasks = [
        (str(shard_path), str(out_dir), args.image_subdir, args.split, idx)
        for idx, shard_path in enumerate(shard_paths)
    ]
    records_by_shard: dict[int, list[str]] = {}
    rows = 0

    if args.workers <= 1:
        for task in tasks:
            idx, records = export_shard(task)
            records_by_shard[idx] = records
            rows += len(records)
            if rows % 1000 == 0:
                print(f"exported {rows}/{len(shard_paths)}", flush=True)
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(export_shard, task) for task in tasks]
            for future in as_completed(futures):
                idx, records = future.result()
                records_by_shard[idx] = records
                rows += len(records)
                if rows >= 1000 and rows % 1000 < len(records):
                    print(f"exported {rows} rows from {len(records_by_shard)}/{len(shard_paths)} shards", flush=True)

    written = 0
    with jsonl_path.open("w", encoding="utf-8") as handle:
        for idx in range(len(shard_paths)):
            for record in records_by_shard[idx]:
                if args.limit and written >= args.limit:
                    break
                handle.write(record + "\n")
                written += 1
            if args.limit and written >= args.limit:
                break

    summary = {
        "shards_dir": str(shards_dir),
        "jsonl": str(jsonl_path),
        "images": str(image_dir),
        "rows": written,
        "exported_rows": rows,
        "snapshot_shards": len(shard_paths),
    }
    (out_dir / f"{args.split}-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
