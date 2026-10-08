"""Publish a local static review of frozen semantic-control decisions."""

import argparse
import hashlib
import html
import json
import shutil
from pathlib import Path


def publish(report_path, output):
    report = json.loads(report_path.read_text())
    output.mkdir(parents=True, exist_ok=False)
    assets = output / "assets"
    assets.mkdir()
    cards = []
    for index, case in enumerate(report["cases"]):
        images = []
        for kind in ("crop_path", "context_path"):
            value = case.get(kind)
            if not value:
                continue
            source = Path(value)
            target = assets / f"{index}-{kind}{source.suffix}"
            shutil.copyfile(source, target)
            images.append(
                f'<img src="assets/{target.name}" alt="{kind}" loading="lazy">'
            )
        ocr = [
            {
                "text": row["text"],
                "e2_selected": row["detector_e2_selected"],
                "semantic": row["semantic_prediction"],
            }
            for row in case["matched_ocr"]
        ]
        selected = (
            "Lyrics candidate"
            if case["combined_lyric_selection"]
            else "Abstain / no lyric candidate"
        )
        cards.append(
            f'<article><h2>{html.escape(case["id"])}</h2>'
            f'<p>Reference: {html.escape(case["ground_truth_role"])}. With semantic gate: {selected}.</p>'
            f'<p>Previous lyric selection: {case["detector_e2_selected"]}; OCR miss: {case["ocr_miss"]}.</p>'
            f'<div>{"".join(images)}</div><pre>{html.escape(json.dumps(ocr, ensure_ascii=False, indent=2))}</pre></article>'
        )
    page = (
        '<!doctype html><meta charset="utf-8"><title>C1 semantic pilot controls</title>'
    )
    page += "<style>body{font:16px system-ui;margin:2rem;max-width:1300px}article{border-top:1px solid #aaa;padding:1rem 0}img{max-width:100%;max-height:420px;object-fit:contain}pre{white-space:pre-wrap}</style>"
    page += "<h1>C1 semantic pilot: existing real-scan controls</h1><p>Research only. This compares OCR role selection with reviewed references; it does not measure new end-to-end note attachments. Unknown is an abstention. Scores are uncalibrated; source roles were used only for evaluation. No individual review decisions are required.</p>"
    page += "<pre>" + html.escape(json.dumps(report["summary"], indent=2)) + "</pre>"
    page += "".join(cards)
    (output / "index.html").write_text(page)
    (output / "report.json").write_bytes(report_path.read_bytes())
    receipt = {
        "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
        "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cases": len(cards),
        "assets": len(list(assets.iterdir())),
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(publish(args.report, args.output), indent=2))
