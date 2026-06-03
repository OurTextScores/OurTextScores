"""
Probe Gemma 4 **kern checkpoints on the Transcoda HF benchmark datasets.

This runs direct page-level generation against:
  - btrkeks/verovio-synth-omr
  - btrkeks/polish-scores

It intentionally reports CER and simple **kern validity only. OMR-NED/TEDn need
the Transcoda metric stack plus hum2xml and are best run after this smoke test.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import PeftModel
from transformers import AutoModelForImageTextToText, AutoProcessor


SYSTEM_PROMPT = (
    "Transcribe the music notation in this full-page image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def edit_distance(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def line_widths(kern: str) -> list[int]:
    widths = []
    for line in kern.splitlines():
        line = line.strip()
        if line:
            widths.append(len(line.split("\t")))
    return widths


def validity(pred: str) -> dict:
    text = pred.strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    widths = line_widths(text)
    non_comment_widths = [
        width for line, width in zip(lines, widths) if not line.startswith("!")
    ]
    return {
        "nonempty": bool(text),
        "has_kern_header": "**kern" in lines[:5] or text.startswith("**kern"),
        "has_terminator": "*-" in lines[-5:] if lines else False,
        "line_count": len(widths),
        "unique_line_widths": sorted(set(non_comment_widths)),
        "stable_line_width": len(set(non_comment_widths)) <= 1 if non_comment_widths else False,
        "length_chars": len(text),
    }


def make_inputs(processor, image, prompt: str) -> dict:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return processor(text=text, images=[image.convert("RGB")], return_tensors="pt", padding=False)


def load_model(model_id: str, checkpoint: str):
    processor = AutoProcessor.from_pretrained(model_id)
    if processor.tokenizer.pad_token is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token
    processor.tokenizer.padding_side = "right"

    base = AutoModelForImageTextToText.from_pretrained(
        model_id,
        device_map="auto",
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(base, checkpoint)
    model.eval()
    model.config.use_cache = True
    return processor, model


def evaluate_dataset(args, processor, model, dataset_name: str) -> list[dict]:
    ds = load_dataset(dataset_name, split=args.split, streaming=True)
    rows = []
    for index, example in enumerate(ds):
        if len(rows) >= args.limit:
            break
        image = example["image"]
        target = example["transcription_kern"].strip()
        inputs = make_inputs(processor, image, args.prompt)
        inputs = {k: v.to(model.device) if hasattr(v, "to") else v for k, v in inputs.items()}
        prompt_len = inputs["input_ids"].shape[1]

        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                num_beams=args.num_beams,
                repetition_penalty=args.repetition_penalty,
                pad_token_id=processor.tokenizer.pad_token_id,
                eos_token_id=processor.tokenizer.eos_token_id,
            )

        pred = processor.tokenizer.decode(
            output_ids[0, prompt_len:], skip_special_tokens=True
        ).strip()
        cer = edit_distance(pred, target) / max(1, len(target))
        row = {
            "dataset": dataset_name,
            "sample_index": index,
            "image_size": list(image.size),
            "prediction": pred,
            "target": target,
            "cer": cer,
            "prediction_validity": validity(pred),
            "target_validity": validity(target),
        }
        rows.append(row)
        print(
            f"{dataset_name} [{len(rows)}/{args.limit}] "
            f"index={index} cer={cer:.3f} valid={row['prediction_validity']}",
            flush=True,
        )
    return rows


def write_report(out_dir: Path, rows: list[dict], args) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "outputs.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    summaries = []
    for dataset in sorted({row["dataset"] for row in rows}):
        subset = [row for row in rows if row["dataset"] == dataset]
        valid = [row["prediction_validity"] for row in subset]
        summaries.append(
            {
                "dataset": dataset,
                "count": len(subset),
                "mean_cer": sum(row["cer"] for row in subset) / max(1, len(subset)),
                "nonempty_rate": sum(v["nonempty"] for v in valid) / max(1, len(valid)),
                "kern_header_rate": sum(v["has_kern_header"] for v in valid) / max(1, len(valid)),
                "terminator_rate": sum(v["has_terminator"] for v in valid) / max(1, len(valid)),
                "stable_line_width_rate": sum(v["stable_line_width"] for v in valid) / max(1, len(valid)),
            }
        )
    summary = {
        "model_id": args.model_id,
        "checkpoint": args.checkpoint,
        "split": args.split,
        "limit_per_dataset": args.limit,
        "max_new_tokens": args.max_new_tokens,
        "num_beams": args.num_beams,
        "repetition_penalty": args.repetition_penalty,
        "datasets": summaries,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    lines = ["# Gemma 4 HF Benchmark Probe", "", "```json", json.dumps(summary, indent=2), "```", ""]
    for row in rows:
        lines.extend(
            [
                f"## {row['dataset']} sample {row['sample_index']} CER={row['cer']:.3f}",
                "",
                "### Prediction",
                "```kern",
                row["prediction"][:6000],
                "```",
                "",
                "### Target",
                "```kern",
                row["target"][:6000],
                "```",
                "",
            ]
        )
    (out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", default="/workspace/models/gemma-4-E4B-it")
    parser.add_argument("--checkpoint", default="/workspace/checkpoints/gemma4-kern-phase-b-v1/checkpoint-4400")
    parser.add_argument("--out-dir", default="/workspace/eval-phase-b-4400-hf-benchmarks")
    parser.add_argument("--datasets", nargs="+", default=["btrkeks/verovio-synth-omr", "btrkeks/polish-scores"])
    parser.add_argument("--split", default="train")
    parser.add_argument("--limit", type=int, default=4)
    parser.add_argument("--max-new-tokens", type=int, default=768)
    parser.add_argument("--num-beams", type=int, default=1)
    parser.add_argument("--repetition-penalty", type=float, default=1.1)
    parser.add_argument("--prompt", default=SYSTEM_PROMPT)
    args = parser.parse_args()

    processor, model = load_model(args.model_id, args.checkpoint)
    rows = []
    for dataset_name in args.datasets:
        rows.extend(evaluate_dataset(args, processor, model, dataset_name))
    write_report(Path(args.out_dir), rows, args)
    print(f"Wrote {args.out_dir}")


if __name__ == "__main__":
    main()
