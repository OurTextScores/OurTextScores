"""Unprompted CPU OCR of frozen scan crops; role labels never enter inference."""

import argparse
import hashlib
import importlib.metadata
import json
import time
from collections import Counter
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ocr_inputs(inventory, review):
    inputs = []
    seen = set()
    for region in inventory:
        if region["id"] in seen:
            raise ValueError("Duplicate crop identity")
        seen.add(region["id"])
        crop = (review / region["crop"]).resolve()
        if not crop.is_relative_to(review.resolve()):
            raise ValueError("Crop outside frozen review directory")
        if sha(crop) != region["crop_sha256"]:
            raise ValueError("Crop hash differs from frozen inventory")
        inputs.append(
            {
                "id": region["id"],
                "crop": str(crop),
                "crop_sha256": region["crop_sha256"],
            }
        )
    return inputs


def recognize(engine, item):
    tick = time.monotonic()
    try:
        result = engine(item["crop"], use_det=True)
        rows = (
            []
            if result.txts is None
            else [
                {"box": coords.tolist(), "text": text, "confidence": float(confidence)}
                for coords, text, confidence in zip(
                    result.boxes, result.txts, result.scores, strict=True
                )
            ]
        )
        return {
            **item,
            "status": "ok" if rows else "empty",
            "rows": rows,
            "seconds": time.monotonic() - tick,
            "source_text_passed_to_ocr": False,
        }
    except Exception as exc:  # noqa: BLE001 — preserve failures
        return {
            **item,
            "status": "error",
            "rows": [],
            "error_type": type(exc).__name__,
            "error": str(exc),
            "seconds": time.monotonic() - tick,
            "source_text_passed_to_ocr": False,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--input-ids", type=Path, help="Optional inference-only shard ID list"
    )
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    all_inputs = ocr_inputs(inventory, args.review)
    inputs = all_inputs
    if args.input_ids:
        ids = json.loads(args.input_ids.read_text())
        if len(ids) != len(set(ids)) or not set(ids).issubset(
            {r["id"] for r in all_inputs}
        ):
            raise ValueError("Invalid shard membership")
        inputs = [r for r in all_inputs if r["id"] in set(ids)]
        inventory = [r for r in inventory if r["id"] in set(ids)]
    import cv2
    import rapidocr
    from rapidocr import RapidOCR

    cv2.setNumThreads(1)
    root = Path(rapidocr.__file__).parent / "models"
    names = {
        "Det": "PP-OCRv6_det_small.onnx",
        "Rec": "PP-OCRv6_rec_small.onnx",
        "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    }
    params = {
        "EngineConfig.onnxruntime.intra_op_num_threads": 1,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": False,
        "Global.log_level": "warning",
    }
    models = {}
    for role, name in names.items():
        path = root / name
        if not path.is_file():
            raise ValueError("Existing local OCR model required: " + str(path))
        params[role + ".model_path"] = str(path)
        models[role] = {"path": str(path), "sha256": sha(path)}
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "inference-inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    (args.out / "extract_semantic_packet_ocr.py").write_bytes(
        Path(__file__).read_bytes()
    )
    engine = RapidOCR(params=params)
    results = []
    tick = time.monotonic()
    with (args.out / "predictions.jsonl").open("w") as stream:
        for index, item in enumerate(inputs):
            result = recognize(engine, item)
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            stream.flush()
            results.append(result)
            if (index + 1) % 20 == 0 or index + 1 == len(inputs):
                elapsed = time.monotonic() - tick
                print(
                    json.dumps(
                        {
                            "completed": index + 1,
                            "total": len(inputs),
                            "elapsed_seconds": elapsed,
                            "eta_seconds": elapsed
                            / (index + 1)
                            * (len(inputs) - index - 1),
                        }
                    ),
                    flush=True,
                )
    roles = {}
    predictions = {r["id"]: r for r in results}
    # Labels enter this post-inference coverage calculation only, never OCR calls.
    for role in sorted({r["ground_truth_role"] for r in inventory}):
        role_results = [
            predictions[r["id"]] for r in inventory if r["ground_truth_role"] == role
        ]
        roles[role] = {
            "total": len(role_results),
            "status": dict(Counter(r["status"] for r in role_results)),
        }
    receipt = {
        "inventory_sha256": sha(args.inventory),
        "input_ids_sha256": sha(args.input_ids) if args.input_ids else None,
        "inference_inputs_sha256": sha(args.out / "inference-inputs.json"),
        "source_sha256": sha(__file__),
        "predictions_sha256": sha(args.out / "predictions.jsonl"),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("rapidocr", "onnxruntime", "numpy")
        },
        "rapidocr_module": rapidocr.__file__,
        "models": models,
        "parameters": params,
        "status": dict(Counter(r["status"] for r in results)),
        "coverage_by_gt_role": roles,
        "seconds": time.monotonic() - tick,
        "source_text_passed_to_ocr": False,
        "gt_roles_passed_to_ocr": False,
        "development_splits_passed_to_ocr": False,
        "scope": "OCR of ground-truth-selected positive scan crops, not whole-page detection/semantic classification or note attachment. No tuning or training. OCR text is unadjudicated.",
    }
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt["coverage_by_gt_role"], indent=2), flush=True)


if __name__ == "__main__":
    main()
