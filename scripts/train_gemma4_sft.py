"""
train_gemma4_sft.py — Phase A Vision SFT for Gemma 4 E4B-it.

Phase A: language LoRA only, vision tower frozen. Trains the language layers
to emit canonical **kern from system-grain crop images.

Adapted from train_vision_sft_qwen.py (Qwen3.5-9B) with:
  - Gemma4ForConditionalGeneration via AutoModelForImageTextToText
  - fp16 (V100 / Volta does not support bf16)
  - Vision freeze targets model.vision_tower (not model.visual)
  - No mm_token_type_ids (Qwen-specific)
  - Target is kern text directly from target.candidate.content
  - Image paths resolve from crops/<split>/<key>.png layout

Environment:
  MODEL_ID          Path or HF ID of Gemma 4 E4B-it (default: /workspace/models/gemma-4-E4B-it)
  VISUAL_DATA       Path to generic-export/train.jsonl
  EVAL_DATA         Path to generic-export/val.jsonl (optional)
  IMAGE_BASE        Root dir where crops/<split>/ lives (default: /workspace/data)
  OUTPUT_DIR        Checkpoint output dir
  MAX_SEQ_LEN       Max tokens per example (default: 2048)
  MAX_STEPS         Training steps (default: 2000)
  LORA_R / LORA_ALPHA
  LOAD_IN_4BIT      1 = QLoRA (default), 0 = full fp16 LoRA
  USE_BF16          1 = bf16 training/loading for A100+ (default 0)
  FREEZE_VISION     1 = freeze vision tower (default, Phase A)
  ADAPTER_INIT      Optional adapter checkpoint to initialize from without
                    resuming optimizer/scheduler state (Phase B)
"""

import json
import os
import io
from pathlib import Path

import torch
from PIL import Image
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)

# ── env config ──────────────────────────────────────────────────────────
MODEL_ID       = os.environ.get("MODEL_ID", "/workspace/models/gemma-4-E4B-it")
VISUAL_DATA    = os.environ.get("VISUAL_DATA", "/workspace/data/generic-export/train.jsonl")
EVAL_DATA      = os.environ.get("EVAL_DATA", "")
IMAGE_BASE     = os.environ.get("IMAGE_BASE", "/workspace/data")
OUTPUT_DIR     = os.environ.get("OUTPUT_DIR", "/workspace/checkpoints/gemma4-kern-sft-v1")
MAX_SEQ_LEN    = int(os.environ.get("MAX_SEQ_LEN", "2048"))
MAX_STEPS      = int(os.environ.get("MAX_STEPS", "2000"))
PER_DEVICE_BATCH_SIZE = int(os.environ.get("PER_DEVICE_BATCH_SIZE", "1"))
GRAD_ACCUM     = int(os.environ.get("GRAD_ACCUM_STEPS", "8"))
SAVE_STEPS     = int(os.environ.get("SAVE_STEPS", "200"))
LOGGING_STEPS  = int(os.environ.get("LOGGING_STEPS", "10"))
LEARNING_RATE  = float(os.environ.get("LEARNING_RATE", "2e-4"))
WARMUP_RATIO   = float(os.environ.get("WARMUP_RATIO", "0.03"))
LORA_R         = int(os.environ.get("LORA_R", "16"))
LORA_ALPHA     = int(os.environ.get("LORA_ALPHA", "32"))
LOAD_IN_4BIT   = os.environ.get("LOAD_IN_4BIT", "1") not in ("0", "false")
USE_BF16        = os.environ.get("USE_BF16", "0") in ("1", "true", "True")
FREEZE_VISION  = os.environ.get("FREEZE_VISION", "1") not in ("0", "false")
MAX_VISUAL_SAMPLES = int(os.environ.get("MAX_VISUAL_SAMPLES", "0"))
EVAL_STEPS     = int(os.environ.get("EVAL_STEPS", "200"))
RESUME_FROM_CHECKPOINT = os.environ.get("RESUME_FROM_CHECKPOINT", "")
ADAPTER_INIT = os.environ.get("ADAPTER_INIT", "")
SKIP_TOKEN_FILTER = os.environ.get("SKIP_TOKEN_FILTER", "0") in ("1", "true", "True")

SYSTEM_PROMPT = (
    "Transcribe the music notation in this image to canonical **kern. "
    "Output only the **kern text, nothing else."
)

# ── data loading ─────────────────────────────────────────────────────────

def resolve_image(image_base: str, ref: str) -> str | None:
    """Resolve imageRef (e.g. 'crops/train/xxx.png') to an absolute path."""
    if not ref:
        return None
    p = Path(image_base) / ref
    return str(p) if p.exists() else None


def _kern_tokens(line: str) -> list[str]:
    return [tok.strip() for tok in line.split("\t") if tok.strip()]


def _is_control_token(token: str) -> bool:
    return (
        token == "."
        or token.startswith("=")
        or token.startswith("*")
        or token.startswith("!")
    )


def _has_measure_bar(tokens: list[str], measure_num: int) -> bool:
    prefix = f"={measure_num}"
    return any(
        token == prefix
        or (token.startswith(prefix) and (len(token) == len(prefix) or not token[len(prefix)].isdigit()))
        for token in tokens
    )


def has_empty_last_measure(kern: str, measure_end: int | None) -> bool:
    """Return True when the requested final measure has no musical/rest tokens."""
    if measure_end is None:
        return False

    lines = kern.splitlines()
    start_idx = None
    for i, line in enumerate(lines):
        if _has_measure_bar(_kern_tokens(line), measure_end):
            start_idx = i
    if start_idx is None:
        return False

    for i in range(start_idx, len(lines)):
        tokens = _kern_tokens(lines[i])
        if not tokens:
            continue
        if i > start_idx:
            if all(token.startswith("*-") for token in tokens):
                break
            if any(token.startswith("=") for token in tokens) and all(_is_control_token(token) for token in tokens):
                break
        if any(not _is_control_token(token) for token in tokens):
            return False
    return True


def load_examples(jsonl_path: str, image_base: str, limit: int = 0) -> list[dict]:
    examples = []
    skipped = skipped_empty_last = 0
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            region_ref = obj.get("input", {}).get("imageRefs", {}).get("region", "")
            img_path = resolve_image(image_base, region_ref)
            if not img_path:
                skipped += 1
                continue
            kern = obj.get("target", {}).get("candidate", {}).get("content", "")
            if not kern.strip():
                skipped += 1
                continue
            measure_end = obj.get("input", {}).get("region", {}).get("measureEnd")
            if has_empty_last_measure(kern, measure_end):
                skipped_empty_last += 1
                continue
            examples.append({
                "img_path": img_path,
                "kern": kern,
                "system": obj.get("system", SYSTEM_PROMPT),
            })
            if limit and len(examples) >= limit:
                break
    print(
        f"Loaded {len(examples)} examples "
        f"(skipped {skipped} missing image/kern, {skipped_empty_last} empty last measure)"
    )
    return examples


# ── tokenization ──────────────────────────────────────────────────────────

def tokenize(processor, img_path: str, kern: str, system: str, max_len: int):
    messages = [
        {"role": "user", "content": [
            {"type": "image", "image": img_path},
            {"type": "text", "text": system},
        ]},
        {"role": "assistant", "content": kern},
    ]
    prompt_messages = messages[:1]

    img = Image.open(img_path).convert("RGB")

    full = processor(
        text=processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False),
        images=[img], return_tensors="pt", padding=False,
    )
    prompt = processor(
        text=processor.apply_chat_template(prompt_messages, tokenize=False, add_generation_prompt=True),
        images=[img], return_tensors="pt", padding=False,
    )

    ids = full["input_ids"][0]
    if len(ids) > max_len:
        return None

    labels = ids.clone()
    labels[:prompt["input_ids"].shape[1]] = -100

    result = {
        "input_ids": ids,
        "attention_mask": full["attention_mask"][0],
        "labels": labels,
    }
    if "pixel_values" in full:
        result["pixel_values"] = full["pixel_values"]
    if "image_position_ids" in full:
        result["image_position_ids"] = full["image_position_ids"]
    if "mm_token_type_ids" in full:
        result["mm_token_type_ids"] = full["mm_token_type_ids"][0]

    return result


class KernDataset(torch.utils.data.Dataset):
    def __init__(self, examples, processor, max_len, cache_path: str = ""):
        self.processor = processor
        self.max_len = max_len
        self.examples = []

        # Cache: skip expensive per-example tokenization on restarts
        if cache_path and Path(cache_path).exists():
            import json as _json
            self.examples = _json.loads(Path(cache_path).read_text())
            print(f"Dataset: {len(self.examples)} examples (loaded from cache {cache_path})")
            return

        if SKIP_TOKEN_FILTER:
            self.examples = list(examples)
            print(f"Dataset: {len(self.examples)} examples (token-length filter skipped)")
            if cache_path:
                import json as _json
                Path(cache_path).write_text(_json.dumps(self.examples))
                print(f"  Saved filter cache to {cache_path}")
            return

        skipped_long = skipped_err = 0
        for i, ex in enumerate(examples):
            if (i + 1) % 500 == 0:
                print(f"  Filtering {i+1}/{len(examples)}...", flush=True)
            try:
                r = tokenize(processor, ex["img_path"], ex["kern"], ex["system"], max_len)
                if r is None:
                    skipped_long += 1
                else:
                    self.examples.append(ex)
            except Exception:
                skipped_err += 1
        print(f"Dataset: {len(self.examples)} examples "
              f"(skipped {skipped_long} too-long, {skipped_err} errors)")

        if cache_path:
            import json as _json
            Path(cache_path).write_text(_json.dumps(self.examples))
            print(f"  Saved filter cache to {cache_path}")

    def __len__(self): return len(self.examples)

    def __getitem__(self, idx):
        ex = self.examples[idx]
        r = tokenize(self.processor, ex["img_path"], ex["kern"], ex["system"], self.max_len)
        if r is None:
            return self[(idx + 1) % len(self)]
        return r


class PadCollator:
    def __init__(self, pad_token_id):
        self.pad_token_id = pad_token_id

    def __call__(self, features):
        max_len = max(f["input_ids"].shape[0] for f in features)
        input_ids, attention_mask, labels = [], [], []
        pixel_values, image_position_ids, mm_token_type_ids = [], [], []

        for f in features:
            pad = max_len - f["input_ids"].shape[0]
            input_ids.append(torch.nn.functional.pad(f["input_ids"], (0, pad), value=self.pad_token_id))
            attention_mask.append(torch.nn.functional.pad(f["attention_mask"], (0, pad), value=0))
            labels.append(torch.nn.functional.pad(f["labels"], (0, pad), value=-100))
            if "pixel_values" in f:
                pixel_values.append(f["pixel_values"])
            if "image_position_ids" in f:
                image_position_ids.append(f["image_position_ids"])
            if "mm_token_type_ids" in f:
                mm_token_type_ids.append(torch.nn.functional.pad(f["mm_token_type_ids"], (0, pad), value=0))

        batch = {
            "input_ids": torch.stack(input_ids),
            "attention_mask": torch.stack(attention_mask),
            "labels": torch.stack(labels),
        }
        if pixel_values:
            batch["pixel_values"] = torch.cat(pixel_values, dim=0)
        if image_position_ids:
            batch["image_position_ids"] = torch.cat(image_position_ids, dim=0)
        if mm_token_type_ids:
            batch["mm_token_type_ids"] = torch.stack(mm_token_type_ids)
        return batch


# ── main ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"Model:      {MODEL_ID}")
    print(f"Data:       {VISUAL_DATA}")
    print(f"Image base: {IMAGE_BASE}")
    print(f"Output:     {OUTPUT_DIR}")
    print(f"QLoRA:      {LOAD_IN_4BIT}  BF16: {USE_BF16}  Freeze vision: {FREEZE_VISION}")
    print(f"Steps:      {MAX_STEPS}  LR: {LEARNING_RATE}  LoRA r={LORA_R}/α={LORA_ALPHA}")

    # Load processor
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    if processor.tokenizer.pad_token is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token
    processor.tokenizer.padding_side = "right"

    # Load model
    compute_dtype = torch.bfloat16 if USE_BF16 else torch.float16
    bnb_cfg = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    ) if LOAD_IN_4BIT else None

    print("Loading model...")
    model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID,
        quantization_config=bnb_cfg,
        device_map="auto",
        dtype=compute_dtype,
        low_cpu_mem_usage=True,
    )

    if LOAD_IN_4BIT:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        model.gradient_checkpointing_enable()

    # LoRA on language attention layers
    target_modules = [
        n for n, _ in model.named_modules()
        if any(n.endswith(s) for s in ("q_proj", "k_proj", "v_proj", "o_proj"))
        and "language_model" in n
    ]
    print(f"LoRA targets: {len(target_modules)} modules")

    if ADAPTER_INIT:
        print(f"Loading trainable adapter from {ADAPTER_INIT}")
        model = PeftModel.from_pretrained(model, ADAPTER_INIT, is_trainable=True)
    else:
        lora_cfg = LoraConfig(
            r=LORA_R,
            lora_alpha=LORA_ALPHA,
            lora_dropout=0.05,
            target_modules=target_modules,
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, lora_cfg)
    model.config.use_cache = False

    # PEFT freezes base-model parameters. For Phase B, explicitly unfreeze the
    # vision tower after adapter creation so the visual front-end can adapt.
    vision_params = 0
    vision_trainable = 0
    for name, param in model.named_parameters():
        if "vision_tower" in name:
            vision_params += 1
            param.requires_grad = not FREEZE_VISION
            if param.requires_grad:
                vision_trainable += 1
    if FREEZE_VISION:
        print(f"Frozen {vision_params} vision tower parameters")
    else:
        print(f"Trainable vision tower parameters: {vision_trainable}/{vision_params}")

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total     = sum(p.numel() for p in model.parameters())
    print(f"Trainable: {trainable:,} / {total:,} ({100*trainable/total:.3f}%)")

    # Load data
    import hashlib as _hl
    cache_key = _hl.md5(f"{VISUAL_DATA}:{IMAGE_BASE}:{MAX_SEQ_LEN}:{MAX_VISUAL_SAMPLES}".encode()).hexdigest()[:10]
    cache_path = str(Path(OUTPUT_DIR).parent / f"filter_cache_{cache_key}.json")

    print("Loading training data...")
    train_examples = load_examples(VISUAL_DATA, IMAGE_BASE, limit=MAX_VISUAL_SAMPLES)
    train_ds = KernDataset(train_examples, processor, MAX_SEQ_LEN, cache_path=cache_path)

    eval_ds = None
    if EVAL_DATA and Path(EVAL_DATA).exists():
        print("Loading eval data...")
        eval_examples = load_examples(EVAL_DATA, IMAGE_BASE, limit=500)
        eval_ds = KernDataset(eval_examples, processor, MAX_SEQ_LEN)

    # Detect resume: read global_step from checkpoint to set correct LR position
    resume_ckpt = RESUME_FROM_CHECKPOINT
    effective_lr = LEARNING_RATE
    effective_warmup_ratio = WARMUP_RATIO
    initial_global_step = 0

    if resume_ckpt and Path(resume_ckpt).exists():
        state_file = Path(resume_ckpt) / "trainer_state.json"
        if state_file.exists():
            import json as _json
            state = _json.loads(state_file.read_text())
            initial_global_step = state.get("global_step", 0)
            # Calculate LR at the resume point in the cosine schedule
            warmup_steps = int(WARMUP_RATIO * MAX_STEPS)
            if initial_global_step >= warmup_steps:
                import math
                progress = (initial_global_step - warmup_steps) / max(1, MAX_STEPS - warmup_steps)
                effective_lr = LEARNING_RATE * (1 + math.cos(math.pi * progress)) / 2
            print(f"Resuming from global_step={initial_global_step}, effective_lr={effective_lr:.2e}")
            effective_warmup_ratio = 0.0  # no warmup on resume

    # Training
    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        learning_rate=effective_lr,
        max_steps=MAX_STEPS,
        per_device_train_batch_size=PER_DEVICE_BATCH_SIZE,
        per_device_eval_batch_size=PER_DEVICE_BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        fp16=not USE_BF16,   # V100 uses fp16; A100 phase B should use bf16
        bf16=USE_BF16,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        logging_strategy="steps",
        logging_steps=LOGGING_STEPS,
        logging_first_step=True,
        save_strategy="steps",
        save_steps=SAVE_STEPS,
        save_total_limit=5,
        lr_scheduler_type="cosine",
        warmup_ratio=effective_warmup_ratio,
        weight_decay=0.01,
        # adamw_8bit (not paged) properly serializes optimizer state for resume
        optim="adamw_8bit" if LOAD_IN_4BIT else "adamw_torch",
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        eval_strategy="steps" if eval_ds else "no",
        eval_steps=EVAL_STEPS if eval_ds else None,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=PadCollator(processor.tokenizer.pad_token_id),
    )

    print(f"Starting training (steps={MAX_STEPS}, batch={PER_DEVICE_BATCH_SIZE}x{GRAD_ACCUM}, lr={effective_lr:.2e})...")
    trainer.train(resume_from_checkpoint=resume_ckpt or None)

    print(f"Saving to {OUTPUT_DIR}")
    trainer.save_model(OUTPUT_DIR)
    processor.save_pretrained(OUTPUT_DIR)
    print("Done.")
