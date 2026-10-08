"""Resume bounded OCR in independent workers and merge frozen results exactly once."""

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from extract_semantic_packet_ocr import ocr_inputs, sha


def merge_predictions(inputs, groups):
    expected = {r["id"]: r for r in inputs}
    found = {}
    for group in groups:
        for result in group:
            case = result["id"]
            if case not in expected or case in found:
                raise ValueError("Duplicate or unknown OCR crop")
            if any(result[k] != expected[case][k] for k in ("crop", "crop_sha256")):
                raise ValueError("Frozen OCR input mismatch")
            if (
                result["status"] not in ("ok", "empty", "error")
                or result["source_text_passed_to_ocr"]
            ):
                raise ValueError("Invalid OCR status or reference leakage")
            if result["status"] == "ok" and not result["rows"]:
                raise ValueError("Successful OCR lacks rows")
            if result["status"] != "ok" and result["rows"]:
                raise ValueError("Unsuccessful OCR has rows")
            for row in result["rows"]:
                if (
                    not isinstance(row["text"], str)
                    or not 0 <= row["confidence"] <= 1
                    or len(row["box"]) != 4
                ):
                    raise ValueError("Malformed OCR row")
            found[case] = result
    if set(found) != set(expected):
        raise ValueError("Missing OCR crops")
    return [found[r["id"]] for r in inputs]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--completed", type=Path, required=True)
    parser.add_argument("--original-source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    inputs = ocr_inputs(inventory, args.review)
    completed_bytes = args.completed.read_bytes()
    prior = [json.loads(line) for line in completed_bytes.decode().splitlines()]
    expected = {r["id"]: r for r in inputs}
    if len({r["id"] for r in prior}) != len(prior):
        raise ValueError("Prior result duplicates")
    for r in prior:
        if r["id"] not in expected or any(
            r[k] != expected[r["id"]][k] for k in ("crop", "crop_sha256")
        ):
            raise ValueError("Prior inputs differ")
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "retained-predictions.jsonl").write_bytes(completed_bytes)
    (args.out / "inference-inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    completed_ids = {r["id"] for r in prior}
    remaining = [r["id"] for r in inputs if r["id"] not in completed_ids]
    extractor = Path(__file__).with_name("extract_semantic_packet_ocr.py")
    (args.out / "extract_semantic_packet_ocr.py").write_bytes(extractor.read_bytes())
    (args.out / "shard_semantic_packet_ocr.py").write_bytes(Path(__file__).read_bytes())
    (args.out / "original-extractor.py").write_bytes(args.original_source.read_bytes())
    for index in range(4):
        (args.out / f"shard-{index}-ids.json").write_text(
            json.dumps(remaining[index::4]) + "\n"
        )

    def run(index):
        shard = args.out / f"shard-{index}"
        ids = args.out / f"shard-{index}-ids.json"
        with (args.out / f"shard-{index}.log").open("w") as log:
            subprocess.run(
                [
                    sys.executable,
                    str(extractor),
                    "--inventory",
                    str(args.inventory),
                    "--review",
                    str(args.review),
                    "--input-ids",
                    str(ids),
                    "--out",
                    str(shard),
                ],
                env={
                    **os.environ,
                    "OMP_NUM_THREADS": "1",
                    "OPENBLAS_NUM_THREADS": "1",
                    "MKL_NUM_THREADS": "1",
                },
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
            )
        receipt = json.loads((shard / "receipt.json").read_text())
        return receipt, [
            json.loads(line)
            for line in (shard / "predictions.jsonl").read_text().splitlines()
        ]

    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(run, range(4)))
    identities = [
        {
            key: r[key]
            for key in (
                "models",
                "packages",
                "parameters",
                "source_sha256",
                "inventory_sha256",
            )
        }
        for r, _ in outcomes
    ]
    if any(identity != identities[0] for identity in identities[1:]):
        raise ValueError("Worker OCR identities differ")
    results = merge_predictions(inputs, [prior] + [rows for _, rows in outcomes])
    (args.out / "predictions.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in results)
    )
    joined = {r["id"]: r for r in results}
    coverage = {
        role: dict(
            Counter(
                joined[r["id"]]["status"]
                for r in inventory
                if r["ground_truth_role"] == role
            )
        )
        for role in sorted({r["ground_truth_role"] for r in inventory})
    }
    receipt = {
        "inventory_sha256": sha(args.inventory),
        "inference_inputs_sha256": sha(args.out / "inference-inputs.json"),
        "retained_sha256": sha(args.out / "retained-predictions.jsonl"),
        "retained_count": len(prior),
        "original_source_sha256": sha(args.original_source),
        "worker_identity": identities[0],
        "shard_receipt_sha256": [
            sha(args.out / f"shard-{i}/receipt.json") for i in range(4)
        ],
        "merged_predictions_sha256": sha(args.out / "predictions.jsonl"),
        "regions": len(results),
        "coverage_by_gt_role": coverage,
        "status": dict(Counter(r["status"] for r in results)),
        "source_text_passed_to_ocr": False,
        "deterministic_unique_complete_merge": True,
        "scope": "Positive GT-selected crop OCR only; no semantic classifier, tuning, reference transcription or attachment accuracy",
    }
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2), flush=True)


if __name__ == "__main__":
    main()
