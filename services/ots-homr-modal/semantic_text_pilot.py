"""Offline, abstaining OCR-text semantic development pilot; never runtime wiring.

Configuration is fixed before fitting: training-only character TF-IDF2–5grams,
minimum document frequency2, at most10000 features, balanced logistic loss,
L2lambda0.01, threshold0.95. Scores are NOT calibrated probabilities.
"""

import argparse
import hashlib
import importlib.metadata
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import minimize
from scipy.special import expit

CONFIG = {
    "ngrams": [2, 3, 4, 5],
    "minimum_document_frequency": 2,
    "maximum_features": 10000,
    "l2_lambda": 0.01,
    "class_weight": "balanced",
    "threshold": 0.95,
    "optimizer": "L-BFGS-B",
    "maximum_iterations": 500,
    "feature_input": "unprompted_crop_ocr_text_only",
    "probability_calibrated": False,
    "hyperparameter_tuning": False,
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def normalized(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).lower()).strip()


def grams(text):
    text = " " + normalized(text) + " "
    return Counter(
        text[i : i + n] for n in CONFIG["ngrams"] for i in range(len(text) - n + 1)
    )


def transform(texts, vocabulary, idf):
    lookup = {term: i for i, term in enumerate(vocabulary)}
    rr, cc, vv = [], [], []
    for row, text in enumerate(texts):
        for term, count in grams(text).items():
            if term in lookup:
                col = lookup[term]
                rr.append(row)
                cc.append(col)
                vv.append((1 + math.log(count)) * idf[col])
    matrix = sparse.csr_matrix(
        (vv, (rr, cc)), shape=(len(texts), len(vocabulary)), dtype=np.float64
    )
    lengths = np.sqrt(np.asarray(matrix.multiply(matrix).sum(axis=1)).ravel())
    scale = np.zeros_like(lengths)
    np.divide(1, lengths, out=scale, where=lengths != 0)
    return sparse.diags(scale).dot(matrix).tocsr()


def objective(theta, matrix, labels, sample_weights):
    logits = matrix @ theta[:-1] + theta[-1]
    loss = np.sum(sample_weights * (np.logaddexp(0, logits) - labels * logits))
    loss += 0.5 * CONFIG["l2_lambda"] * np.dot(theta[:-1], theta[:-1])
    error = sample_weights * (expit(logits) - labels)
    gradient = np.concatenate(
        (
            np.asarray(matrix.T @ error).ravel() + CONFIG["l2_lambda"] * theta[:-1],
            [np.sum(error)],
        )
    )
    return float(loss), gradient


def fit(texts, labels):
    frequency = Counter(term for text in texts for term in grams(text))
    vocabulary = sorted(
        term
        for term, count in sorted(
            frequency.items(), key=lambda item: (-item[1], item[0])
        )[: CONFIG["maximum_features"]]
        if count >= CONFIG["minimum_document_frequency"]
    )
    if not vocabulary or set(labels) != {0, 1}:
        raise ValueError("Need training text features and both semantic classes")
    idf = [
        math.log((1 + len(texts)) / (1 + frequency[term])) + 1 for term in vocabulary
    ]
    matrix = transform(texts, vocabulary, idf)
    y = np.asarray(labels, dtype=np.float64)
    weights = np.asarray([0.5 / labels.count(int(label)) for label in labels])
    result = minimize(
        objective,
        np.zeros(len(vocabulary) + 1),
        args=(matrix, y, weights),
        jac=True,
        method=CONFIG["optimizer"],
        options={"maxiter": CONFIG["maximum_iterations"], "ftol": 1e-12, "gtol": 1e-8},
    )
    if not result.success or not np.isfinite(result.x).all():
        raise ValueError("Optimization failed: " + str(result.message))
    return {
        "config": CONFIG,
        "vocabulary": vocabulary,
        "idf": idf,
        "weights": result.x[:-1].tolist(),
        "intercept": float(result.x[-1]),
        "optimizer_receipt": {
            "success": bool(result.success),
            "iterations": int(result.nit),
            "final_objective": float(result.fun),
            "message": str(result.message),
        },
    }


def predict_rows(model, observations, threshold=None):
    threshold = model["config"]["threshold"] if threshold is None else threshold
    texts = [row["text"] for row in observations]
    matrix = transform(texts, model["vocabulary"], model["idf"])
    scores = expit(matrix @ np.asarray(model["weights"]) + model["intercept"])
    predictions = []
    for row, text, score in zip(observations, texts, scores, strict=True):
        empty = not normalized(text)
        prediction = (
            "Unknown"
            if empty
            else (
                "Lyrics"
                if score >= threshold
                else "DirectionText" if score <= 1 - threshold else "Unknown"
            )
        )
        predictions.append(
            {
                "id": row["id"],
                "prediction": prediction,
                "lyric_probability": None if empty else float(score),
                "uncalibrated_score": True,
                "empty_text": empty,
            }
        )
    return predictions


def coverage(records, predictions):
    index = {r["id"]: r for r in predictions}
    result = {}
    for role in ("Lyrics", "DirectionText"):
        refs = [r for r in records if r["ground_truth_role"] == role]
        counts = Counter(index[r["id"]]["prediction"] for r in refs)
        n = len(refs)
        false_lyrics = counts["Lyrics"] if role == "DirectionText" else None
        result[role] = {
            "support": n,
            "predictions": dict(counts),
            "empty_text": sum(index[r["id"]]["empty_text"] for r in refs),
            "correct_nonabstaining": counts[role],
            "correct_rate_including_abstention": counts[role] / n if n else None,
            "false_lyric_selections": false_lyrics,
            "zero_false_lyric_one_sided95_upper_bound": (
                1 - 0.05 ** (1 / n) if n and false_lyrics == 0 else None
            ),
        }
    return result


def development(args):
    inventory = json.loads(args.inventory.read_text())
    ocr_receipt = json.loads(args.ocr_receipt.read_text())
    if ocr_receipt["inventory_sha256"] != sha(args.inventory) or ocr_receipt[
        "merged_predictions_sha256"
    ] != sha(args.ocr_predictions):
        raise ValueError("Frozen OCR receipt does not match inputs")
    if any(
        r["source_partition"] != "calibration"
        or r["ground_truth_role"] not in ("Lyrics", "DirectionText")
        for r in inventory
    ):
        raise ValueError(
            "Require original calibration positives in the two pilot roles"
        )
    results = [
        json.loads(line) for line in args.ocr_predictions.read_text().splitlines()
    ]
    observations = {r["id"]: r for r in results}
    if len(observations) != len(results) or set(observations) != {
        r["id"] for r in inventory
    }:
        raise ValueError("OCR coverage differs from frozen packet")
    for region in inventory:
        ocr = observations[region["id"]]
        if (
            ocr["crop_sha256"] != region["crop_sha256"]
            or ocr["source_text_passed_to_ocr"]
        ):
            raise ValueError("OCR identity or reference leakage failure")
    train = [r for r in inventory if r["development_split"] == "training-candidate"]
    calibration = [
        r for r in inventory if r["development_split"] == "internal-calibration"
    ]
    train_scores = sorted({r["score"] for r in train})
    calibration_scores = sorted({r["score"] for r in calibration})
    if set(train_scores) & set(calibration_scores) or len(train) + len(
        calibration
    ) != len(inventory):
        raise ValueError("Invalid score-disjoint development split")
    text_inputs = [
        {"id": r["id"], "text": " ".join(row["text"] for row in r["rows"])}
        for r in results
    ]
    texts = {r["id"]: r["text"] for r in text_inputs}
    usable_train = [r for r in train if normalized(texts[r["id"]])]
    args.out.mkdir(parents=True, exist_ok=False)
    write(args.out / "prespecified-config.json", CONFIG)
    write(args.out / "inference-text-inputs.json", text_inputs)
    (args.out / "semantic_text_pilot.py").write_bytes(Path(__file__).read_bytes())
    model = fit(
        [texts[r["id"]] for r in usable_train],
        [int(r["ground_truth_role"] == "Lyrics") for r in usable_train],
    )
    write(args.out / "model.json", model)
    predictions = predict_rows(model, text_inputs)
    write(args.out / "predictions.json", predictions)
    calibration_ids = {r["id"] for r in calibration}
    cal_inputs = [r for r in text_inputs if r["id"] in calibration_ids]
    baselines = {}
    for name, prediction in (
        ("always_abstain", "Unknown"),
        ("nonempty_training_majority_lyrics", "Lyrics"),
    ):
        rows = [
            {
                "id": r["id"],
                "prediction": "Unknown" if not normalized(r["text"]) else prediction,
                "empty_text": not normalized(r["text"]),
            }
            for r in cal_inputs
        ]
        baselines[name] = coverage(calibration, rows)
    report = {
        "fixed_threshold": CONFIG["threshold"],
        "training": coverage(train, predictions),
        "internal_calibration": coverage(calibration, predictions),
        "trivial_baselines": baselines,
        "internal_calibration_by_score": {
            score: coverage(
                [r for r in calibration if r["score"] == score], predictions
            )
            for score in calibration_scores
        },
        "exploratory_sensitivity_not_tuned_or_selected": {
            str(t): coverage(calibration, predict_rows(model, cal_inputs, t))
            for t in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99)
        },
        "training_nonempty_roles": dict(
            Counter(r["ground_truth_role"] for r in usable_train)
        ),
        "training_empty_omitted_from_loss_not_from_coverage": len(train)
        - len(usable_train),
        "limitations": [
            "Only11 internal-calibration direction regions; even zero false selections has24% one-sided95% upper bound",
            "Uncalibrated logistic scores, no promotion-quality probability interpretation",
            "Partial existing positive annotation roles remain unadjudicated; no title/credit or OSSQ coverage",
            "GT-selected crop OCR differs from full-page OCR; external controls measured separately",
            "No actual note attachment evaluated; no runtime wiring or promotion",
            "Exploratory threshold grid is reporting only, no threshold selection",
        ],
    }
    write(args.out / "report.json", report)
    receipt = {
        "training_scores": train_scores,
        "internal_calibration_scores": calibration_scores,
        "inventory_sha256": sha(args.inventory),
        "ocr_predictions_sha256": sha(args.ocr_predictions),
        "ocr_receipt_sha256": sha(args.ocr_receipt),
        "source_sha256": sha(__file__),
        "model_sha256": sha(args.out / "model.json"),
        "prediction_sha256": sha(args.out / "predictions.json"),
        "report_sha256": sha(args.out / "report.json"),
        "config": CONFIG,
        "packages": {
            name: importlib.metadata.version(name) for name in ("numpy", "scipy")
        },
        "calibration_used_for_fit": False,
        "threshold_tuned_on_calibration": False,
        "source_reference_text_used": False,
        "features": "OCR text characters only; no ID, score, file name, geometry, confidence, split or GT role input",
        "calibration_support": len(calibration),
        "training_support": len(train),
        "training_nonempty_support": len(usable_train),
    }
    write(args.out / "model-receipt.json", receipt)
    print(json.dumps(report["internal_calibration"], indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--ocr-predictions", type=Path)
    parser.add_argument("--ocr-receipt", type=Path)
    parser.add_argument("--predict-inputs", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.predict_inputs:
        if not args.model:
            parser.error("Prediction requires --model")
        args.out.mkdir(parents=True, exist_ok=False)
        model = json.loads(args.model.read_text())
        inputs = json.loads(args.predict_inputs.read_text())
        predictions = predict_rows(model, inputs)
        write(args.out / "predictions.json", predictions)
        write(
            args.out / "prediction-receipt.json",
            {
                "input_sha256": sha(args.predict_inputs),
                "model_sha256": sha(args.model),
                "source_sha256": sha(__file__),
                "config": model["config"],
                "predictions_sha256": sha(args.out / "predictions.json"),
                "source_text_passed_to_inference": False,
            },
        )
    else:
        if not all((args.inventory, args.ocr_predictions, args.ocr_receipt)):
            parser.error("Development requires inventory, OCR predictions and receipt")
        development(args)


if __name__ == "__main__":
    main()
