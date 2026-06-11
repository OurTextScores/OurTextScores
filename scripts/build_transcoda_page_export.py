#!/usr/bin/env python3
"""
Build Transcoda-style page-level Gemma JSONL from existing P0 renders.

This uses:
  - data/p0/render/<split>/<scoreId>-pNN.png
  - data/p0/kern/<scoreId>.kern
  - data/p0/crops/<split>/<scoreId>-layout.json when available

Targets are normalized with Transcoda's 21-pass normalizer by default. That
matches the released HF benchmark style: no leading **kern declaration and no
terminal *- line. Use --keep-wrappers only for a bridge curriculum.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any


SYSTEM_PROMPT = (
    "Transcribe this full-page music image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def add_transcoda_to_path(path: str) -> None:
    sys.path.insert(0, str(Path(path).resolve()))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--p0-root", default="/home/jhlusko/workspace/data/p0")
    parser.add_argument("--transcoda-root", default="/home/jhlusko/workspace/transcoda")
    parser.add_argument("--out-dir", default="/home/jhlusko/workspace/data/p0/page-export")
    parser.add_argument("--splits", default="train,val,test")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--keep-wrappers", action="store_true")
    parser.add_argument("--allow-terminators", action="store_true")
    parser.add_argument("--allow-null-dots", action="store_true")
    parser.add_argument("--max-target-chars", type=int, default=0)
    return parser.parse_args()


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def is_header_or_global(line: str) -> bool:
    stripped = line.strip()
    return (
        stripped.startswith("**")
        or stripped.startswith("*clef")
        or stripped.startswith("*k[")
        or re.match(r"^\*M\d", stripped) is not None
    )


def is_barline(line: str) -> bool:
    return line.strip().startswith("=")


def bar_number(line: str) -> int | None:
    match = re.match(r"^=+(\d+)", line.strip())
    return int(match.group(1)) if match else None


def latest_context_before(lines: list[str], start_measure: int) -> list[str]:
    header: list[str] = []
    clef: str | None = None
    key: str | None = None
    meter: str | None = None

    for line in lines:
        num = bar_number(line)
        if num is not None and num >= start_measure:
            break
        stripped = line.strip()
        if stripped.startswith("**"):
            header = [line]
        elif stripped.startswith("*clef"):
            clef = line
        elif stripped.startswith("*k["):
            key = line
        elif re.match(r"^\*M\d", stripped):
            meter = line

    return header + [line for line in (clef, key, meter) if line]


def slice_kern_measures(kern_text: str, start_measure: int, end_measure: int) -> str:
    lines = [line.rstrip("\n") for line in kern_text.splitlines()]
    context = latest_context_before(lines, start_measure)
    body: list[str] = []
    in_range = False

    for line in lines:
        stripped = line.strip()
        num = bar_number(line)
        if num is not None:
            if num == start_measure:
                in_range = True
            elif num > end_measure:
                break

        if in_range:
            if stripped == "*-":
                continue
            if is_header_or_global(stripped) and not is_barline(stripped) and not body:
                continue
            body.append(line)

    if not body:
        return ""

    # Keep a terminator pre-normalization; Transcoda strips it by default.
    return "\n".join(context + body + ["*-"]) + "\n"


def page_measure_range(layout: dict[str, Any], page_index: int) -> tuple[int, int] | None:
    pages = layout.get("pages") or []
    page = next((p for p in pages if p.get("pageIndex") == page_index), None)
    if not page or not page.get("hasMusicContent", True):
        return None
    ranges: list[tuple[int, int]] = []
    for system in page.get("systems") or []:
        measure_range = system.get("measureRange")
        if (
            isinstance(measure_range, list)
            and len(measure_range) == 2
            and isinstance(measure_range[0], int)
            and isinstance(measure_range[1], int)
        ):
            ranges.append((measure_range[0], measure_range[1]))
    if not ranges:
        return None
    return min(start for start, _ in ranges), max(end for _, end in ranges)


def wrap_kern_if_needed(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    lines = stripped.splitlines()
    width = max(1, lines[0].count("\t") + 1)
    if not lines[0].startswith("**"):
        lines.insert(0, "\t".join(["**kern"] * width))
    if not lines[-1].startswith("*-"):
        lines.append("\t".join(["*-"] * width))
    return "\n".join(lines) + "\n"


def line_tokens(line: str) -> list[str]:
    return [token.strip() for token in line.split("\t") if token.strip()]


def has_kern_header(text: str) -> bool:
    return any(token.startswith("**") for line in text.splitlines() for token in line_tokens(line))


def has_terminator(text: str) -> bool:
    return any(token.startswith("*-") for line in text.splitlines() for token in line_tokens(line))


def has_null_dot_token(text: str) -> bool:
    return any(token == "." for line in text.splitlines() for token in line_tokens(line))


def process_score(task: tuple[str, str, str, str, bool, bool, bool, int]) -> tuple[str, list[dict], dict]:
    (
        score_id,
        split,
        p0_root_s,
        transcoda_root_s,
        keep_wrappers,
        allow_terminators,
        allow_null_dots,
        max_target_chars,
    ) = task
    add_transcoda_to_path(transcoda_root_s)
    from scripts.dataset_generation.normalization.presets import normalize_kern_transcription

    p0_root = Path(p0_root_s)
    kern_path = p0_root / "kern" / f"{score_id}.kern"
    render_dir = p0_root / "render" / split
    layout_path = p0_root / "crops" / split / f"{score_id}-layout.json"

    stats = {"scoreId": score_id, "pages": 0, "skipped": 0, "errors": []}
    if not kern_path.exists():
        stats["errors"].append("kern_missing")
        return split, [], stats

    try:
        kern_text = kern_path.read_text(encoding="utf-8")
    except Exception as exc:
        stats["errors"].append(f"kern_read_error:{exc}")
        return split, [], stats

    page_paths = sorted(render_dir.glob(f"{score_id}-p*.png"))
    if not page_paths:
        stats["errors"].append("page_png_missing")
        return split, [], stats

    layout = read_json(layout_path) if layout_path.exists() else None
    rows: list[dict] = []
    single_page = len(page_paths) == 1

    for png_path in page_paths:
        match = re.search(r"-p(\d+)\.png$", png_path.name)
        page_index = int(match.group(1)) if match else 1

        if single_page:
            page_kern = kern_text
            measure_range = None
        elif layout:
            measure_range = page_measure_range(layout, page_index)
            if not measure_range:
                stats["skipped"] += 1
                continue
            page_kern = slice_kern_measures(kern_text, measure_range[0], measure_range[1])
        else:
            stats["skipped"] += 1
            continue

        if not page_kern.strip():
            stats["skipped"] += 1
            continue

        try:
            target = wrap_kern_if_needed(page_kern) if keep_wrappers else normalize_kern_transcription(page_kern)
        except Exception as exc:
            stats["skipped"] += 1
            stats["errors"].append(f"normalize_error:{type(exc).__name__}:{exc}")
            continue

        target = target.strip() + "\n"
        if not keep_wrappers and has_kern_header(target):
            stats["skipped"] += 1
            stats["errors"].append("post_normalize_header")
            continue
        if not allow_terminators and has_terminator(target):
            stats["skipped"] += 1
            stats["errors"].append("post_normalize_terminator")
            continue
        if not allow_null_dots and has_null_dot_token(target):
            stats["skipped"] += 1
            stats["errors"].append("post_normalize_null_dot")
            continue
        if max_target_chars and len(target) > max_target_chars:
            stats["skipped"] += 1
            stats["errors"].append("target_too_long_chars")
            continue

        rel_image = f"render/{split}/{png_path.name}"
        example_id = png_path.stem
        rows.append(
            {
                "exampleId": example_id,
                "taskType": "transcribe_full_page",
                "system": SYSTEM_PROMPT,
                "input": {
                    "grain": "page",
                    "region": {
                        "pageIndex": page_index,
                        "measureStart": measure_range[0] if measure_range else None,
                        "measureEnd": measure_range[1] if measure_range else None,
                    },
                    "imageRefs": {"page": rel_image, "region": rel_image},
                },
                "target": {
                    "candidate": {"content": target},
                    "overall_confidence": 1.0,
                    "findings": [],
                    "evidence_spans": [
                        {
                            "pageIndex": page_index,
                            "measureStart": measure_range[0] if measure_range else None,
                            "measureEnd": measure_range[1] if measure_range else None,
                        }
                    ],
                },
            }
        )
        stats["pages"] += 1

    return split, rows, stats


def collect_scores(p0_root: Path, splits: list[str], limit: int) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for split in splits:
        render_dir = p0_root / "render" / split
        score_ids = sorted({path.name.split("-p", 1)[0] for path in render_dir.glob("*-p*.png")})
        for score_id in score_ids:
            result.append((score_id, split))
            if limit and len(result) >= limit:
                return result
    return result


def main() -> None:
    args = parse_args()
    p0_root = Path(args.p0_root)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    splits = [split.strip() for split in args.splits.split(",") if split.strip()]

    scores = collect_scores(p0_root, splits, args.limit)
    tasks = [
        (
            score_id,
            split,
            str(p0_root),
            args.transcoda_root,
            args.keep_wrappers,
            args.allow_terminators,
            args.allow_null_dots,
            args.max_target_chars,
        )
        for score_id, split in scores
    ]
    print(f"Building page export for {len(tasks)} scores into {out_dir}", file=sys.stderr)

    handles = {split: (out_dir / f"{split}.jsonl").open("w", encoding="utf-8") for split in splits}
    summary = {
        "scores": len(tasks),
        "splits": {split: {"rows": 0, "scores_with_rows": 0, "skipped_pages": 0, "errors": {}} for split in splits},
        "keep_wrappers": args.keep_wrappers,
        "allow_terminators": args.allow_terminators,
        "allow_null_dots": args.allow_null_dots,
        "max_target_chars": args.max_target_chars,
    }

    try:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(process_score, task): task for task in tasks}
            for i, future in enumerate(as_completed(futures), 1):
                split, rows, stats = future.result()
                if rows:
                    for row in rows:
                        handles[split].write(json.dumps(row, ensure_ascii=False) + "\n")
                    summary["splits"][split]["rows"] += len(rows)
                    summary["splits"][split]["scores_with_rows"] += 1
                summary["splits"][split]["skipped_pages"] += int(stats["skipped"])
                for err in stats["errors"]:
                    summary["splits"][split]["errors"][err] = summary["splits"][split]["errors"].get(err, 0) + 1
                if i % 1000 == 0:
                    print(f"processed {i}/{len(tasks)} scores", file=sys.stderr)
    finally:
        for handle in handles.values():
            handle.close()

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), file=sys.stderr)


if __name__ == "__main__":
    main()
