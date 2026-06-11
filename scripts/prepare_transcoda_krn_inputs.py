#!/usr/bin/env python3
"""Normalize local P0 kern files into Transcoda dataset-generator inputs."""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kern-dir", default="/workspace/data/kern")
    parser.add_argument("--out-dir", default="/workspace/data/transcoda-input/p0")
    parser.add_argument("--transcoda-root", default="/workspace/transcoda")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--allow-terminators", action="store_true")
    return parser.parse_args()


def has_terminator_token(text: str) -> bool:
    for line in text.splitlines():
        for token in line.split("\t"):
            if token.strip().startswith("*-"):
                return True
    return False


def process_one(task: tuple[str, str, str, bool]) -> dict[str, object]:
    src_s, out_dir_s, transcoda_root_s, allow_terminators = task
    sys.path.insert(0, str(Path(transcoda_root_s).resolve()))
    from scripts.dataset_generation.normalization.presets import normalize_kern_transcription

    src = Path(src_s)
    out_dir = Path(out_dir_s)
    out = out_dir / f"{src.stem}.krn"
    try:
        text = src.read_text(encoding="utf-8", errors="ignore")
        normalized = normalize_kern_transcription(text).strip()
        if not normalized:
            return {"src": str(src), "ok": False, "reason": "empty_normalized"}
        if not allow_terminators and has_terminator_token(normalized):
            return {"src": str(src), "ok": False, "reason": "post_normalize_terminator"}
        out.write_text(normalized + "\n", encoding="utf-8")
        return {"src": str(src), "ok": True, "chars": len(normalized)}
    except Exception as exc:
        return {
            "src": str(src),
            "ok": False,
            "reason": f"{type(exc).__name__}:{exc}",
        }


def main() -> None:
    args = parse_args()
    kern_dir = Path(args.kern_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    paths = sorted(kern_dir.glob("*.kern"))
    if args.limit:
        paths = paths[: args.limit]
    tasks = [(str(path), str(out_dir), args.transcoda_root, args.allow_terminators) for path in paths]

    summary = {
        "inputs": len(tasks),
        "ok": 0,
        "failed": 0,
        "allow_terminators": args.allow_terminators,
        "reasons": {},
    }
    failures_path = out_dir / "normalization-failures.jsonl"
    with failures_path.open("w", encoding="utf-8") as failures:
        with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [pool.submit(process_one, task) for task in tasks]
            for idx, future in enumerate(as_completed(futures), 1):
                result = future.result()
                if result.get("ok"):
                    summary["ok"] += 1
                else:
                    summary["failed"] += 1
                    reason = str(result.get("reason", "unknown"))
                    summary["reasons"][reason] = summary["reasons"].get(reason, 0) + 1
                    failures.write(json.dumps(result, ensure_ascii=False) + "\n")
                if idx % 1000 == 0:
                    print(f"processed {idx}/{len(tasks)}", flush=True)

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
