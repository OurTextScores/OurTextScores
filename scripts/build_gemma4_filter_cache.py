#!/usr/bin/env python3
"""Build the Gemma SFT filter cache without tokenizing images."""

import argparse
import hashlib
import json
from pathlib import Path


SYSTEM_PROMPT = (
    "Transcribe the music notation in this image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def kern_tokens(line: str) -> list[str]:
    return [tok.strip() for tok in line.split("\t") if tok.strip()]


def is_control_token(token: str) -> bool:
    return (
        token == "."
        or token.startswith("=")
        or token.startswith("*")
        or token.startswith("!")
    )


def has_measure_bar(tokens: list[str], measure_num: int) -> bool:
    prefix = f"={measure_num}"
    return any(
        token == prefix
        or (token.startswith(prefix) and (len(token) == len(prefix) or not token[len(prefix)].isdigit()))
        for token in tokens
    )


def has_empty_last_measure(kern: str, measure_end: int | None) -> bool:
    if measure_end is None:
        return False

    lines = kern.splitlines()
    start_idx = None
    for i, line in enumerate(lines):
        if has_measure_bar(kern_tokens(line), measure_end):
            start_idx = i
    if start_idx is None:
        return False

    for i in range(start_idx, len(lines)):
        tokens = kern_tokens(lines[i])
        if not tokens:
            continue
        if i > start_idx:
            if all(token.startswith("*-") for token in tokens):
                break
            if any(token.startswith("=") for token in tokens) and all(is_control_token(token) for token in tokens):
                break
        if any(not is_control_token(token) for token in tokens):
            return False
    return True


def cache_path(output_dir: Path, visual_data: str, image_base: str, max_seq_len: int, max_visual_samples: int) -> Path:
    key = hashlib.md5(
        f"{visual_data}:{image_base}:{max_seq_len}:{max_visual_samples}".encode()
    ).hexdigest()[:10]
    return output_dir.parent / f"filter_cache_{key}.json"


def build_cache(args: argparse.Namespace) -> None:
    visual_data = Path(args.visual_data)
    image_base = Path(args.image_base)
    output_dir = Path(args.output_dir)
    examples = []
    skipped_missing = 0
    skipped_empty_last = 0

    with visual_data.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            region_ref = obj.get("input", {}).get("imageRefs", {}).get("region", "")
            img_path = image_base / region_ref
            kern = obj.get("target", {}).get("candidate", {}).get("content", "")
            if not region_ref or not img_path.exists() or not kern.strip():
                skipped_missing += 1
                continue
            measure_end = obj.get("input", {}).get("region", {}).get("measureEnd")
            if has_empty_last_measure(kern, measure_end):
                skipped_empty_last += 1
                continue
            examples.append({
                "img_path": str(img_path),
                "kern": kern,
                "system": obj.get("system", SYSTEM_PROMPT),
            })
            if args.max_visual_samples and len(examples) >= args.max_visual_samples:
                break

    out = cache_path(
        output_dir,
        args.visual_data,
        args.image_base,
        args.max_seq_len,
        args.max_visual_samples,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(examples), encoding="utf-8")
    tmp.replace(out)

    print(f"Wrote {len(examples)} examples to {out}")
    print(f"Skipped {skipped_missing} missing image/kern")
    print(f"Skipped {skipped_empty_last} empty last measure")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--visual-data", default="/workspace/data/generic-export/train.jsonl")
    parser.add_argument("--image-base", default="/workspace/data")
    parser.add_argument("--output-dir", default="/workspace/checkpoints/gemma4-kern-sft-v1")
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--max-visual-samples", type=int, default=0)
    build_cache(parser.parse_args())


if __name__ == "__main__":
    main()
