"""Select an offline semantic policy using training-score out-of-fold predictions.

Previously inspected calibration/control scores are reporting only, not untouched
qualification. Zero observed direction errors is a development constraint, not a
precision guarantee. No runtime attachment or model publication occurs.
"""

import argparse
import hashlib
import json
from pathlib import Path

import semantic_text_pilot as pilot

LAMBDAS = [0.0001, 0.001, 0.01, 0.1]
THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]


def score_fold(score):
    return (
        int(
            hashlib.sha256(("semantic-train-cv-v1:" + score).encode()).hexdigest()[:8],
            16,
        )
        % 5
    )


def select_policy(rows, policy="zero-error"):
    if policy == "retain95-proxy":
        eligible = []
        for row in rows:
            lyrics = row["metrics"]["Lyrics"]
            usable = lyrics["support"] - lyrics["empty_text"]
            if usable and row["selected_lyrics"] / usable >= 0.95:
                eligible.append(row)
        return (
            min(
                eligible,
                key=lambda r: (
                    r["false_direction_lyrics"],
                    -r["selected_lyrics"],
                    -r["threshold"],
                    -r["lambda"],
                ),
            )
            if eligible
            else None
        )
    if policy != "zero-error":
        raise ValueError("Unknown development selection policy")
    eligible = [
        r for r in rows if r["false_direction_lyrics"] == 0 and r["selected_lyrics"] > 0
    ]
    return (
        max(eligible, key=lambda r: (r["selected_lyrics"], r["threshold"], r["lambda"]))
        if eligible
        else None
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--selection-policy",
        choices=("zero-error", "retain95-proxy"),
        default="zero-error",
    )
    args = parser.parse_args()
    inventory_path = args.packet / "inventory.json"
    ocr_path = args.packet / "ocr-scan-only-sharded/predictions.jsonl"
    ocr_receipt = json.loads(
        (args.packet / "ocr-scan-only-sharded/receipt.json").read_text()
    )
    if (
        pilot.sha(inventory_path) != ocr_receipt["inventory_sha256"]
        or pilot.sha(ocr_path) != ocr_receipt["merged_predictions_sha256"]
    ):
        raise ValueError("Frozen packet/OCR changed")
    inventory = json.loads(inventory_path.read_text())
    ocr = [json.loads(line) for line in ocr_path.read_text().splitlines()]
    observed = {r["id"]: r for r in ocr}
    if len(observed) != len(ocr) or set(observed) != {r["id"] for r in inventory}:
        raise ValueError("Missing or duplicate OCR records")
    for region in inventory:
        row = observed[region["id"]]
        if (
            row["crop_sha256"] != region["crop_sha256"]
            or row["source_text_passed_to_ocr"]
        ):
            raise ValueError("Changed crop or reference leakage")
    texts = {r["id"]: " ".join(t["text"] for t in r["rows"]) for r in ocr}
    train = [r for r in inventory if r["development_split"] == "training-candidate"]
    calibration = [
        r for r in inventory if r["development_split"] == "internal-calibration"
    ]
    if {r["score"] for r in train} & {r["score"] for r in calibration}:
        raise ValueError("Score overlap")
    args.out.mkdir(parents=True, exist_ok=False)
    policy = {
        "lambdas": LAMBDAS,
        "thresholds": THRESHOLDS,
        "folds": 5,
        "selection_policy": args.selection_policy,
        "selection": (
            "Retain at least95% of nonempty GT-crop lyric OCR as a DEVELOPMENT PROXY; minimize direction false selections, then maximize retention. Actual gate requires e2-selected genuine fullpage OCR candidates, unavailable in training packet."
            if args.selection_policy == "retain95-proxy"
            else "zero observed direction-to-lyric errors and at least one lyric retained; maximize full-support lyric recall; ties higher threshold then larger lambda"
        ),
        "release_gate_established_by_training_packet": False,
        "threshold_probability_calibrated": False,
        "calibration_used_for_selection": False,
    }
    pilot.write(args.out / "prespecified-selection.json", policy)
    (args.out / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    (args.out / "semantic_text_pilot.py").write_bytes(Path(pilot.__file__).read_bytes())
    grid, oof = [], {}
    for regularization in LAMBDAS:
        pilot.CONFIG["l2_lambda"] = regularization
        predictions = []
        fold_receipts = []
        for fold in range(5):
            held = [r for r in train if score_fold(r["score"]) == fold]
            fit_rows = [
                r
                for r in train
                if score_fold(r["score"]) != fold and pilot.normalized(texts[r["id"]])
            ]
            model = pilot.fit(
                [texts[r["id"]] for r in fit_rows],
                [int(r["ground_truth_role"] == "Lyrics") for r in fit_rows],
            )
            model["config"] = dict(model["config"])
            predictions.extend(
                pilot.predict_rows(
                    model, [{"id": r["id"], "text": texts[r["id"]]} for r in held]
                )
            )
            fold_receipts.append(
                {
                    "fold": fold,
                    "fit_scores": sorted({r["score"] for r in fit_rows}),
                    "held_scores": sorted({r["score"] for r in held}),
                }
            )
        if len(predictions) != len(train) or len({r["id"] for r in predictions}) != len(
            train
        ):
            raise ValueError("OOF coverage incomplete")
        oof[str(regularization)] = {"predictions": predictions, "folds": fold_receipts}
        for threshold in THRESHOLDS:
            decisions = []
            for row in predictions:
                p = row["lyric_probability"]
                decisions.append(
                    {
                        **row,
                        "prediction": (
                            "Unknown"
                            if p is None
                            else (
                                "Lyrics"
                                if p >= threshold
                                else (
                                    "DirectionText" if p <= 1 - threshold else "Unknown"
                                )
                            )
                        ),
                    }
                )
            metrics = pilot.coverage(train, decisions)
            grid.append(
                {
                    "lambda": regularization,
                    "threshold": threshold,
                    "selected_lyrics": metrics["Lyrics"]["predictions"].get(
                        "Lyrics", 0
                    ),
                    "false_direction_lyrics": metrics["DirectionText"][
                        "false_lyric_selections"
                    ],
                    "metrics": metrics,
                }
            )
    pilot.write(args.out / "out-of-fold.json", oof)
    selected = select_policy(grid, args.selection_policy)
    pilot.write(args.out / "selected-policy.json", selected)
    report = {
        "selection_grid": grid,
        "selected_policy": selected,
        "scope": "Training-score OOF development selection; calibration is already inspected, not independent qualification",
    }
    if selected is not None:
        pilot.CONFIG["l2_lambda"] = selected["lambda"]
        pilot.CONFIG["threshold"] = selected["threshold"]
        usable = [r for r in train if pilot.normalized(texts[r["id"]])]
        model = pilot.fit(
            [texts[r["id"]] for r in usable],
            [int(r["ground_truth_role"] == "Lyrics") for r in usable],
        )
        model["config"] = dict(model["config"])
        pilot.write(args.out / "model.json", model)
        predictions = pilot.predict_rows(
            model, [{"id": r["id"], "text": texts[r["id"]]} for r in calibration]
        )
        pilot.write(args.out / "predictions.json", predictions)
        report["previously_inspected_calibration"] = pilot.coverage(
            calibration, predictions
        )
    pilot.write(args.out / "report.json", report)
    receipt = {
        "training_scores": sorted({r["score"] for r in train}),
        "internal_calibration_scores": sorted({r["score"] for r in calibration}),
        "inventory_sha256": pilot.sha(inventory_path),
        "ocr_predictions_sha256": pilot.sha(ocr_path),
        "source_sha256": pilot.sha(__file__),
        "base_pilot_sha256": pilot.sha(pilot.__file__),
        "model_sha256": (
            pilot.sha(args.out / "model.json") if selected is not None else None
        ),
        "policy": policy,
        "config": dict(pilot.CONFIG),
        "calibration_used_for_selection": False,
    }
    pilot.write(args.out / "model-receipt.json", receipt)
    print(
        json.dumps(
            {
                "selected_policy": selected,
                "calibration": report.get("previously_inspected_calibration"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
