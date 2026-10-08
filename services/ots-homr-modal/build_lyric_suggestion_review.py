"""Publish source-free fullpage lyric suggestions for explicit human review only."""

import argparse
import json
import math
import shutil
from pathlib import Path

from PIL import Image
from semantic_external_controls import rect, sha, union_coverage


def build(base, prediction_dir, out):
    receipt = json.loads((prediction_dir / "receipt.json").read_text())
    predictions = json.loads(
        (prediction_dir / "prediction/predictions.json").read_text()
    )
    prediction_receipt = json.loads(
        (prediction_dir / "prediction/prediction-receipt.json").read_text()
    )
    if (
        sha(prediction_dir / "inputs.json") != prediction_receipt["input_sha256"]
        or sha(prediction_dir / "prediction/predictions.json")
        != prediction_receipt["predictions_sha256"]
    ):
        raise ValueError("Frozen inference inputs/predictions changed")
    by_id = {r["id"]: r for r in predictions}
    frozen = {}
    for source in receipt["frozen_sources"]:
        path = Path(source["path"])
        if sha(path) != source["sha256"]:
            raise ValueError("Frozen source changed")
        frozen[path] = source["sha256"]
    out.mkdir(parents=True, exist_ok=False)
    assets = out / "assets"
    assets.mkdir()
    pages = []
    for score in receipt["external_scores"]:
        page_path = next(
            p
            for p in frozen
            if p.name == score + ".json" and p.parent.name == "full-ocr"
        )
        page = json.loads(page_path.read_text())
        image_path = Path(page["image"])
        if (
            sha(image_path) != page["image_sha256"]
            or page["source_text_passed_to_ocr"] is not False
        ):
            raise ValueError("Page identity or OCR source-free receipt failed")
        gate_paths = [
            p
            for p in frozen
            if p.name == score + ".json" and p.parent.name == "area200-coverage0.1"
        ]
        if gate_paths:
            selected = {
                json.dumps(row["box"])
                for row in json.loads(gate_paths[0].read_text())["all_page_text"]
            }
            keep = lambda row, boxes=selected: json.dumps(row["box"]) in boxes
        else:
            regions_path = next(
                p
                for p in frozen
                if p.name == score + ".json" and p.parent.name == "e2-region-ocr"
            )
            regions = json.loads(regions_path.read_text())
            if regions["image_sha256"] != page["image_sha256"]:
                raise ValueError("Detector/OCR image mismatch")
            areas = [r for rows in regions["areas"].values() for r in rows]
            keep = lambda row, boxes=areas: union_coverage(row["box"], boxes) >= 0.1
        suggestions = []
        with Image.open(image_path) as image:
            for i, row in enumerate(page["all_page_text"]):
                if not keep(row):
                    continue
                case_id = f"{score}:ocr:{i}"
                prediction = by_id[case_id]
                box = rect(row["box"])
                x, y, xx, yy = map(
                    int,
                    (
                        math.floor(box[0]),
                        math.floor(box[1]),
                        math.ceil(box[2]),
                        math.ceil(box[3]),
                    ),
                )
                if not (0 <= x < xx <= image.width and 0 <= y < yy <= image.height):
                    raise ValueError("OCR box outside original page")
                crop = f"{score}-{i}.png"
                context = f"{score}-{i}-context.jpg"
                image.crop(
                    (
                        max(0, x - 12),
                        max(0, y - 12),
                        min(image.width, xx + 12),
                        min(image.height, yy + 12),
                    )
                ).convert("RGB").save(assets / crop)
                image.crop(
                    (
                        max(0, x - 100),
                        max(0, y - 100),
                        min(image.width, xx + 100),
                        min(image.height, yy + 100),
                    )
                ).convert("RGB").save(assets / context, quality=88)
                suggestions.append(
                    {
                        "id": case_id,
                        "ocrText": row["text"],
                        "box": row["box"],
                        "proposed": prediction["prediction"] == "Lyrics",
                        "crop": "assets/" + crop,
                        "context": "assets/" + context,
                    }
                )
        pages.append(
            {
                "score": score,
                "imageSha256": page["image_sha256"],
                "suggestions": suggestions,
            }
        )
    data = {
        "schemaVersion": "ots.lyric-suggestion-review.v1",
        "modelSha256": prediction_receipt["model_sha256"],
        "automaticAttachment": False,
        "pages": pages,
    }
    (out / "suggestions.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    )
    template = Path(__file__).with_name("lyric_suggestion_review.html")
    shutil.copyfile(template, out / "index.html")
    result = {
        "source_sha256": sha(Path(__file__)),
        "template_sha256": sha(template),
        "suggestions_sha256": sha(out / "suggestions.json"),
        "prediction_receipt_sha256": sha(
            prediction_dir / "prediction/prediction-receipt.json"
        ),
        "page_count": len(pages),
        "suggestions": sum(len(p["suggestions"]) for p in pages),
        "proposed": sum(s["proposed"] for p in pages for s in p["suggestions"]),
        "gt_roles_or_reference_text_in_suggestions": False,
        "automatic_attachment": False,
        "model_sha256": data["modelSha256"],
    }
    (out / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--prediction-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.base, args.prediction_dir, args.out), indent=2))
