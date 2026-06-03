"""
Generate and score a small Gemma 4 OMR sample set from a LoRA checkpoint.

This is intentionally lightweight: it answers whether the checkpoint can emit
plausible **kern at all, before doing full OMR-NED/render evaluation.
"""

import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from peft import PeftModel
from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig


SYSTEM_PROMPT = (
    "Transcribe the music notation in this image to canonical **kern. "
    "Output only the **kern text, nothing else."
)


def resolve_image(image_base: Path, ref: str) -> Path | None:
    if not ref:
        return None
    path = image_base / ref
    return path if path.exists() else None


def load_examples(jsonl_path: Path, image_base: Path, limit: int) -> list[dict]:
    examples = []
    with jsonl_path.open() as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            image_ref = obj.get("input", {}).get("imageRefs", {}).get("region", "")
            image_path = resolve_image(image_base, image_ref)
            target = obj.get("target", {}).get("candidate", {}).get("content", "")
            if not image_path or not target.strip():
                continue
            examples.append(
                {
                    "example_id": obj.get("exampleId", ""),
                    "image_ref": image_ref,
                    "image_path": str(image_path),
                    "system": obj.get("system") or SYSTEM_PROMPT,
                    "target": target,
                }
            )
            if len(examples) >= limit:
                break
    return examples


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
        if not line:
            continue
        widths.append(len(line.split("\t")))
    return widths


def validity(pred: str) -> dict:
    text = pred.strip()
    widths = line_widths(text)
    non_comment_widths = [
        w
        for line, w in zip([l.strip() for l in text.splitlines() if l.strip()], widths)
        if not line.startswith("!")
    ]
    return {
        "nonempty": bool(text),
        "has_kern_header": "**kern" in text.splitlines()[:5] or text.startswith("**kern"),
        "has_terminator": "*-" in text.splitlines()[-5:] if text else False,
        "line_count": len(widths),
        "unique_line_widths": sorted(set(non_comment_widths)),
        "stable_line_width": len(set(non_comment_widths)) <= 1 if non_comment_widths else False,
        "length_chars": len(text),
    }


def make_inputs(processor, image_path: str, system: str) -> dict:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image_path},
                {"type": "text", "text": system},
            ],
        }
    ]
    img = Image.open(image_path).convert("RGB")
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return processor(text=text, images=[img], return_tensors="pt", padding=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", default="/workspace/models/gemma-4-E4B-it")
    parser.add_argument("--checkpoint", default="/workspace/checkpoints/gemma4-kern-sft-v1/checkpoint-6400")
    parser.add_argument("--data", default="/workspace/data/generic-export/val.jsonl")
    parser.add_argument("--image-base", default="/workspace/data")
    parser.add_argument("--out-dir", default="/workspace/eval-gemma4-kern")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--load-in-4bit", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    processor = AutoProcessor.from_pretrained(args.model_id)
    if processor.tokenizer.pad_token is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token
    processor.tokenizer.padding_side = "right"

    bnb_cfg = (
        BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
        )
        if args.load_in_4bit
        else None
    )
    base = AutoModelForImageTextToText.from_pretrained(
        args.model_id,
        quantization_config=bnb_cfg,
        device_map="auto",
        dtype=torch.float16,
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(base, args.checkpoint)
    model.eval()
    model.config.use_cache = True

    examples = load_examples(Path(args.data), Path(args.image_base), args.limit)
    rows = []
    for i, ex in enumerate(examples, 1):
        inputs = make_inputs(processor, ex["image_path"], ex["system"])
        inputs = {k: v.to(model.device) if hasattr(v, "to") else v for k, v in inputs.items()}
        prompt_len = inputs["input_ids"].shape[1]
        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                num_beams=1,
                pad_token_id=processor.tokenizer.pad_token_id,
                eos_token_id=processor.tokenizer.eos_token_id,
            )
        new_ids = output_ids[0, prompt_len:]
        pred = processor.tokenizer.decode(new_ids, skip_special_tokens=True).strip()
        target = ex["target"].strip()
        cer = edit_distance(pred, target) / max(1, len(target))
        row = {
            **{k: ex[k] for k in ("example_id", "image_ref")},
            "prediction": pred,
            "target": target,
            "cer": cer,
            "prediction_validity": validity(pred),
            "target_validity": validity(target),
        }
        rows.append(row)
        print(f"[{i}/{len(examples)}] {ex['example_id']} cer={cer:.3f} valid={row['prediction_validity']}")

    jsonl_path = out_dir / "outputs.jsonl"
    with jsonl_path.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    valid = [r["prediction_validity"] for r in rows]
    summary = {
        "checkpoint": args.checkpoint,
        "data": args.data,
        "count": len(rows),
        "mean_cer": sum(r["cer"] for r in rows) / max(1, len(rows)),
        "nonempty_rate": sum(v["nonempty"] for v in valid) / max(1, len(valid)),
        "kern_header_rate": sum(v["has_kern_header"] for v in valid) / max(1, len(valid)),
        "terminator_rate": sum(v["has_terminator"] for v in valid) / max(1, len(valid)),
        "stable_line_width_rate": sum(v["stable_line_width"] for v in valid) / max(1, len(valid)),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    lines = ["# Gemma 4 Kern Eval", "", "```json", json.dumps(summary, indent=2), "```", ""]
    for row in rows:
        lines.extend(
            [
                f"## {row['example_id']}  CER={row['cer']:.3f}",
                "",
                "### Prediction",
                "```kern",
                row["prediction"][:4000],
                "```",
                "",
                "### Target",
                "```kern",
                row["target"][:4000],
                "```",
                "",
            ]
        )
    (out_dir / "report.md").write_text("\n".join(lines))
    print(f"Wrote {jsonl_path}")


if __name__ == "__main__":
    main()
