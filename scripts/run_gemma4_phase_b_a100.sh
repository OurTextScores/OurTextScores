#!/usr/bin/env bash
set -euo pipefail

export MODEL_ID="${MODEL_ID:-/workspace/models/gemma-4-E4B-it}"
export VISUAL_DATA="${VISUAL_DATA:-/workspace/data/generic-export/train.jsonl}"
export EVAL_DATA="${EVAL_DATA:-/workspace/data/generic-export/val.jsonl}"
export IMAGE_BASE="${IMAGE_BASE:-/workspace/data}"
export OUTPUT_DIR="${OUTPUT_DIR:-/workspace/checkpoints/gemma4-kern-phase-b-v1}"
export ADAPTER_INIT="${ADAPTER_INIT:-/workspace/checkpoints/gemma4-kern-sft-v1/checkpoint-6400}"

export MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"
export MAX_STEPS="${MAX_STEPS:-30000}"
export PER_DEVICE_BATCH_SIZE="${PER_DEVICE_BATCH_SIZE:-1}"
export GRAD_ACCUM_STEPS="${GRAD_ACCUM_STEPS:-8}"
export SAVE_STEPS="${SAVE_STEPS:-200}"
export LOGGING_STEPS="${LOGGING_STEPS:-10}"
export LEARNING_RATE="${LEARNING_RATE:-2e-5}"
export WARMUP_RATIO="${WARMUP_RATIO:-0.03}"
export LORA_R="${LORA_R:-16}"
export LORA_ALPHA="${LORA_ALPHA:-32}"
export LOAD_IN_4BIT="${LOAD_IN_4BIT:-0}"
export USE_BF16="${USE_BF16:-1}"
export FREEZE_VISION="${FREEZE_VISION:-0}"
export SKIP_TOKEN_FILTER="${SKIP_TOKEN_FILTER:-0}"

mkdir -p "$OUTPUT_DIR" /workspace/logs

echo "Phase B A100 run"
echo "  MODEL_ID=$MODEL_ID"
echo "  VISUAL_DATA=$VISUAL_DATA"
echo "  EVAL_DATA=$EVAL_DATA"
echo "  IMAGE_BASE=$IMAGE_BASE"
echo "  OUTPUT_DIR=$OUTPUT_DIR"
echo "  ADAPTER_INIT=$ADAPTER_INIT"
echo "  MAX_STEPS=$MAX_STEPS"
echo "  LEARNING_RATE=$LEARNING_RATE"
echo "  USE_BF16=$USE_BF16"
echo "  FREEZE_VISION=$FREEZE_VISION"

exec timeout 24h python3 /workspace/train_gemma4_sft.py
