"""
Score HF benchmark probe outputs with Transcoda-style OMR-NED.

Input is the outputs.jsonl produced by eval_gemma4_hf_benchmarks.py. This keeps
expensive generation separate from CPU-heavy metric computation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def add_transcoda_to_path(path: str | None) -> None:
    if path:
        sys.path.insert(0, str(Path(path).resolve()))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", required=True, help="Path to outputs.jsonl")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--transcoda-root", default=None)
    args = parser.parse_args()

    add_transcoda_to_path(args.transcoda_root)
    from src.evaluation.omr_ned import compute_omr_ned, is_musicdiff_available
    from src.evaluation.omr_ned_aggregation import resolve_omr_ned_score

    if not is_musicdiff_available():
        raise SystemExit("musicdiff/converter21/music21 are not importable")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    with Path(args.inputs).open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            result = compute_omr_ned(obj["prediction"], obj["target"])
            score, failed = resolve_omr_ned_score(result)
            rows.append(
                {
                    "dataset": obj["dataset"],
                    "sample_index": obj["sample_index"],
                    "cer": obj.get("cer"),
                    "omr_ned": score,
                    "omr_ned_failed": failed,
                    "parse_error": result.parse_error,
                    "edit_distance": result.edit_distance,
                    "pred_notation_size": result.pred_notation_size,
                    "gt_notation_size": result.gt_notation_size,
                    "syntax_errors_fixed": result.syntax_errors_fixed,
                }
            )
            print(
                f"{obj['dataset']} sample={obj['sample_index']} "
                f"omr_ned={score:.3f} failed={failed}",
                flush=True,
            )

    summaries = []
    for dataset in sorted({row["dataset"] for row in rows}):
        subset = [row for row in rows if row["dataset"] == dataset]
        summaries.append(
            {
                "dataset": dataset,
                "count": len(subset),
                "mean_omr_ned": sum(row["omr_ned"] for row in subset) / max(1, len(subset)),
                "failure_rate": sum(row["omr_ned_failed"] for row in subset) / max(1, len(subset)),
                "mean_cer": sum(row["cer"] for row in subset if row["cer"] is not None)
                / max(1, sum(row["cer"] is not None for row in subset)),
            }
        )

    summary = {"inputs": args.inputs, "datasets": summaries}
    (out_dir / "omr_ned_per_sample.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    (out_dir / "omr_ned_summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
