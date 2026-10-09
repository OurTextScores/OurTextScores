"""Diagnostic CPU OCR geometry for explicitly reviewed syllables; no text substitution."""

import argparse
import hashlib
import json
import time
from pathlib import Path

import cv2
import numpy as np
from lyric_ocr import LyricTextPipeline
from score_anchor_judgements import score_review


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--padding", type=int, nargs="+", default=[8, 24])
    args = parser.parse_args()
    if len(args.padding) < 2 or any(p < 0 or p > 256 for p in args.padding):
        raise ValueError("Require at least two bounded crop paddings")
    review_dir = args.base / "guarded-tuplet-20261004/review"
    key_path = review_dir / "lyric-anchor-judgement-2-20261008-key.json"
    items_path = review_dir / "lyric-anchor-clear-markers-20261008/items.json"
    key = {r["id"]: r for r in json.loads(key_path.read_text())}
    review = json.loads(args.review.read_text())
    scored = score_review(
        json.loads(items_path.read_text()), list(key.values()), review
    )
    pages_path = args.base / "lyric-fresh2-upload-audit-20261008/fresh2-pages.txt"
    pages = dict(line.split(" ", 1) for line in pages_path.read_text().splitlines())
    args.out.mkdir(parents=True, exist_ok=False)
    cv2.setNumThreads(2)
    pipeline = LyricTextPipeline(gate=None, threads=2)
    cases, input_hashes = [], {
        str(p): sha(p) for p in (key_path, items_path, args.review, pages_path)
    }
    for correction in scored["reviewedSyllableCorrections"]:
        start = time.monotonic()
        item = key[correction["id"]]
        inv_path = (
            args.base
            / f'lyric-fresh2-upload-audit-20261008/saved-fresh2-inputs/inventory-{item["score"]}.json'
        )
        inventory = json.loads(inv_path.read_text())
        row = next(r for r in inventory["ocrRows"] if r["id"] == item["row"])
        image_path = Path(pages[item["score"]])
        image = cv2.imread(str(image_path))
        if image is None:
            raise ValueError("Page image cannot be read")
        raster = inventory["raster"]
        image = cv2.resize(image, (raster["width"], raster["height"]))
        input_hashes.update({str(p): sha(p) for p in (image_path, inv_path)})
        trials = []
        for padding in args.padding:
            x0, y0, x1, y1 = row["box"]
            left, top = max(0, x0 - padding), max(0, y0 - padding)
            right, bottom = min(image.shape[1], x1 + padding), min(
                image.shape[0], y1 + padding
            )
            crop = image[top:bottom, left:right]
            name = correction["id"] + f"-pad{padding}.png"
            cv2.imwrite(str(args.out / name), crop)
            # Reviewer text is deliberately not passed to OCR. It only selects
            # literal matching characters after source-free recognition.
            result = pipeline.engine(
                crop, return_word_box=True, return_single_char_box=True
            )
            recognized = []
            matches = []
            if result.txts is not None:
                for text, characters in zip(
                    result.txts, result.word_results, strict=True
                ):
                    chars = [
                        {"text": str(char), "box": np.asarray(box).tolist()}
                        for char, _, box in characters
                    ]
                    stream = "".join(c["text"] for c in chars)
                    recognized.append({"text": str(text), "characters": chars})
                    wanted = correction["correctedText"]
                    starts = [
                        i for i in range(len(stream)) if stream.startswith(wanted, i)
                    ]
                    for index in starts:
                        selected = chars[index : index + len(wanted)]
                        centers = np.array(
                            [np.asarray(c["box"]).mean(axis=0) for c in selected]
                        )
                        center = centers.mean(axis=0) + [left, top]
                        if not row["box"][1] <= center[1] <= row["box"][3]:
                            continue
                        matches.append(
                            {
                                "text": wanted,
                                "centerRaster": center.tolist(),
                                "selectedCharacters": selected,
                            }
                        )
            trials.append(
                {
                    "padding": padding,
                    "crop": name,
                    "recognized": recognized,
                    "literalMatches": matches,
                    "uniqueLiteralMatch": len(matches) == 1,
                }
            )
        usable = [t["literalMatches"][0] for t in trials if t["uniqueLiteralMatch"]]
        consistent = (
            len(usable) == len(trials)
            and max(match["centerRaster"][0] for match in usable)
            - min(match["centerRaster"][0] for match in usable)
            <= 5
        )
        case = {
            "correction": correction,
            "originalRow": row["text"],
            "trials": trials,
            "geometryStableAcrossPadding": consistent,
            "candidateCenterRaster": usable[0]["centerRaster"] if consistent else None,
            "oldProposedNote": {
                k: item[k]
                for k in ("staffIndex", "measureInStaff", "noteOrdinal", "notePitch")
            },
            "notePlacementConfirmed": False,
            "seconds": time.monotonic() - start,
        }
        cases.append(case)
        (args.out / "progress.json").write_text(
            json.dumps(
                {
                    "completed": len(cases),
                    "total": len(scored["reviewedSyllableCorrections"]),
                }
            )
            + "\n"
        )
        print(
            item["score"],
            correction["originalText"],
            "->",
            correction["correctedText"],
            "stable" if consistent else "unresolved",
            flush=True,
        )
    report = {
        "cases": cases,
        "inputSha256": input_hashes,
        "sourceSha256": sha(Path(__file__)),
        "reviewedTextPassedToOcr": False,
        "automaticAttachment": False,
        "scope": "Selected user-corrected crop geometry, development only; crop padding stability is a diagnostic, not certified glyph boundaries or note ownership.",
    }
    (args.out / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    )
    (args.out / Path(__file__).name).write_bytes(Path(__file__).read_bytes())


if __name__ == "__main__":
    main()
