"""Frozen full-page OCR controls for an offline lyric-role pilot, never inference GT.

Preparation publishes every OCR row before matching separate positive references.
Scoring accepts frozen model predictions; no fitting or threshold selection occurs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


def rect(box):
    if len(box) == 4 and isinstance(box[0], (int, float)):
        return tuple(box)
    return (
        min(p[0] for p in box),
        min(p[1] for p in box),
        max(p[0] for p in box),
        max(p[1] for p in box),
    )


def coverage(reference, observed):
    a, b = rect(reference), rect(observed)
    area = (a[2] - a[0]) * (a[3] - a[1])
    return (
        max(0, min(a[2], b[2]) - max(a[0], b[0]))
        * max(0, min(a[3], b[3]) - max(a[1], b[1]))
        / area
        if area > 0
        else 0
    )


def union_coverage(box, regions):
    """Exact union of clipped e2 rectangles, avoiding double-counted overlaps."""
    x0, y0, x1, y1 = rect(box)
    clipped = []
    for r in regions:
        if r.get("label") != "Lyrics":
            continue
        a, b, c, d = (r[k] for k in ("left", "top", "right", "bottom"))
        if (c - a) * (d - b) < 200:
            continue
        q = max(x0, a), max(y0, b), min(x1, c), min(y1, d)
        if q[2] > q[0] and q[3] > q[1]:
            clipped.append(q)
    xs = sorted({x for r in clipped for x in (r[0], r[2])})
    total = 0
    for a, b in pairwise(xs):
        intervals = sorted((r[1], r[3]) for r in clipped if r[0] < b and r[2] > a)
        end = -float("inf")
        length = 0
        for lo, hi in intervals:
            length += max(0, hi - max(lo, end))
            end = max(end, hi)
        total += (b - a) * length
    return total / ((x1 - x0) * (y1 - y0)) if x1 > x0 and y1 > y0 else 0


def prepare(base: Path, output: Path):
    if output.exists():
        raise ValueError("Output exists; controls cannot be silently replaced")
    frozen = []

    def load(relative):
        p = base / relative
        frozen.append({"path": str(p.resolve()), "sha256": sha(p)})
        return read(p)

    baseline = load("c1-semantic-baseline-20261007/scored/report.json")
    originals = load("c1-semantic-controls-20261005/inventory.json")
    inventory = load("c1-semantic-gt-packet-20261007/inventory.json")
    external_scores = {x["score"] for x in baseline["cases"]} | {
        x["score"] for x in originals
    }
    development_scores = {x["score"] for x in inventory}
    if external_scores & development_scores:
        raise ValueError("External score overlaps development packet")
    inputs = []
    by_score = {}
    selected = {}
    ocr_paths = {}
    attachment_traces = {}
    baseline_scores = {x["score"] for x in baseline["cases"]}
    for score in sorted(external_scores):
        folder = (
            "c1-semantic-expansion-20261006"
            if score in baseline_scores
            else "c1-layout-expansion-20261005"
        )
        relative = f"{folder}/full-ocr/{score}.json"
        page = load(relative)
        if page.get("source_text_passed_to_ocr") is not False:
            raise ValueError("OCR lacks explicit source-free receipt")
        image = Path(page["image"])
        if sha(image) != page["image_sha256"]:
            raise ValueError("Page image changed")
        if score in baseline_scores:
            gate = load(
                f"c1-semantic-baseline-20261007/gate/area200-coverage0.1/{score}.json"
            )
            selected_boxes = {json.dumps(x["box"]) for x in gate["all_page_text"]}
            selected[score] = [
                json.dumps(x["box"]) in selected_boxes for x in page["all_page_text"]
            ]
        else:
            regions = load(f"c1-layout-expansion-20261005/e2-region-ocr/{score}.json")
            if regions["image_sha256"] != page["image_sha256"]:
                raise ValueError("Detector and OCR images differ")
            areas = [x for group in regions["areas"].values() for x in group]
            selected[score] = [
                union_coverage(x["box"], areas) >= 0.1 for x in page["all_page_text"]
            ]
            attachment_traces[score] = load(
                f"c1-semantic-controls-20261005/{score}-baseline.json"
            )
        by_score[score] = page
        ocr_paths[score] = str((base / relative).resolve())
        for i, row in enumerate(page["all_page_text"]):
            inputs.append(
                {
                    "id": f"{score}:ocr:{i}",
                    "text": row["text"],
                    "confidence": row["confidence"],
                    "bbox": row["box"],
                }
            )
    cases = []
    for old in baseline["cases"]:
        row = dict(old)
        score = row["score"]
        row["packet"] = "expanded42-codex-inspected"
        row["ground_truth_role"] = row.pop("reference_role")
        row["baseline_stage"] = row.pop("stage")
        row["baseline_prediction"] = row.pop("prediction")
        row["crop_path"] = str(
            (base / "c1-semantic-expansion-review-20261006-v2" / row["crop"]).resolve()
        )
        row["context_path"] = str(
            (
                base / "c1-semantic-expansion-review-20261006-v2" / row["context"]
            ).resolve()
        )
        row["attached_token_count_before_gate"] = None
        cases.append(row)
    for i, old in enumerate(originals):
        score = old["score"]
        traces = attachment_traces[score].get("attachment_trace", [])
        matches = [t for t in traces if t.get("box") == old["box"]]
        cases.append(
            {
                "id": f"original6-{i}",
                "score": score,
                "packet": "original6-human-confirmed-directions",
                "ground_truth_role": "DirectionText",
                "box": old["box"],
                "crop_path": str(
                    (base / "c1-semantic-controls-20261005" / old["crop"]).resolve()
                ),
                "context_path": None,
                "attached_token_count_before_gate": sum(
                    t.get("outcome") == "attached" for t in matches
                ),
                "baseline_attachment_trace": matches,
            }
        )
    dependencies = defaultdict(list)
    for case in cases:
        score = case["score"]
        page = by_score[score]
        case["source_image"] = page["image"]
        case["ocr_source_path"] = ocr_paths[score]
        case["matched_ocr"] = []
        for i, row in enumerate(page["all_page_text"]):
            cov = coverage(case["box"], row["box"])
            if cov >= 0.5:
                oid = f"{score}:ocr:{i}"
                case["matched_ocr"].append(
                    {
                        "id": oid,
                        "text": row["text"],
                        "confidence": row["confidence"],
                        "bbox": row["box"],
                        "reference_coverage": cov,
                        "detector_e2_selected": selected[score][i],
                    }
                )
                dependencies[oid].append(case["id"])
        case["ocr_miss"] = not case["matched_ocr"]
        case["detector_e2_selected"] = any(
            x["detector_e2_selected"] for x in case["matched_ocr"]
        )
    output.mkdir(parents=True)
    for name, obj in [("inputs.json", inputs), ("evaluation.json", cases)]:
        (output / name).write_text(json.dumps(obj, indent=2) + "\n")
    receipt = {
        "frozen_sources": frozen,
        "script_sha256": sha(Path(__file__)),
        "inputs_sha256": sha(output / "inputs.json"),
        "evaluation_sha256": sha(output / "evaluation.json"),
        "source_text_or_role_passed_to_inference": False,
        "development_score_count": len(development_scores),
        "external_scores": sorted(external_scores),
        "score_overlap": [],
        "region_count": len(cases),
        "full_page_ocr_row_count": len(inputs),
        "shared_ocr_rows": {k: v for k, v in dependencies.items() if len(v) > 1},
        "reference_matching_minimum_coverage": 0.5,
        "detector_gate": {"minimum_area": 200, "minimum_union_coverage": 0.1},
        "note_attachment_scored": False,
        "limitation": "Expanded42 references Codex inspected; original6 human-confirmed. Positive references do not establish whole-page precision. Original attachment traces preserved only; any veto is conditional replay, not fresh end-to-end attachment.",
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def evaluate(output: Path, predictions: list[dict], model_receipt: dict):
    receipt = read(output / "receipt.json")
    for filename, key in [
        ("inputs.json", "inputs_sha256"),
        ("evaluation.json", "evaluation_sha256"),
    ]:
        if sha(output / filename) != receipt[key]:
            raise ValueError("Frozen controls changed")
    inputs = read(output / "inputs.json")
    expected = {x["id"] for x in inputs}
    predicted = {x["id"]: x for x in predictions}
    if len(predicted) != len(predictions) or set(predicted) != expected:
        raise ValueError("Predictions must cover every unique full-page OCR row")
    cases = read(output / "evaluation.json")
    summary = {}
    for case in cases:
        matches = case["matched_ocr"]
        candidate = False
        semantic = []
        for row in matches:
            prediction = predicted[row["id"]]
            if prediction["prediction"] not in {"Lyrics", "DirectionText", "Unknown"}:
                raise ValueError("Unsupported semantic role")
            row["semantic_prediction"] = prediction
            semantic.append(prediction["prediction"])
            candidate |= (
                row["detector_e2_selected"] and prediction["prediction"] == "Lyrics"
            )
        case["semantic_only_lyric_selection"] = any(x == "Lyrics" for x in semantic)
        case["combined_lyric_selection"] = candidate
        case["conditional_attachment_veto"] = (
            None
            if case["attached_token_count_before_gate"] is None
            else (
                not case["semantic_only_lyric_selection"]
                and case["attached_token_count_before_gate"] > 0
            )
        )
        key = case["packet"] + ":" + case["ground_truth_role"]
        counts = summary.setdefault(key, Counter())
        counts.update(
            {
                "regions": 1,
                "ocr_misses": int(case["ocr_miss"]),
                "baseline_e2_lyric_selections": int(case["detector_e2_selected"]),
                "semantic_only_lyric_selections": int(
                    case["semantic_only_lyric_selection"]
                ),
                "combined_lyric_selections": int(candidate),
                "semantic_unknown_regions": int(
                    not semantic or all(x == "Unknown" for x in semantic)
                ),
            }
        )
    report = {
        "summary": summary,
        "cases": cases,
        "model_receipt": model_receipt,
        "controls_receipt": receipt,
        "note_attachment_scored": False,
        "threshold_tuned_on_controls": False,
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--predictions", type=Path)
    p.add_argument("--model-receipt", type=Path)
    args = p.parse_args()
    if args.predictions:
        evaluate(args.output, read(args.predictions), read(args.model_receipt))
    else:
        if not args.base:
            p.error("--base is required for preparation")
        prepare(args.base, args.output)


if __name__ == "__main__":
    main()
