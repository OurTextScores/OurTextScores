"""Compare old/new scores on the same pinned e2 probabilities; no policy change."""

import argparse
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    import cv2
    import torch
    from detector_runtime.detector_inference import boxes_from_probs, predict_mask
    from detector_runtime.runtime import TextDetector
    from pins import DETECTORS

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    prepared = args.base / "lyric-prepared-controls-20261008"
    page = next(
        p
        for p in json.loads((prepared / "pages.json").read_text())
        if p["score"] == "IMSLP508574"
    )
    image_path = Path(page["image"])
    if sha(image_path) != page["image_sha256"]:
        raise ValueError("Prepared image changed")
    repo, revision, filename, digest = DETECTORS["lyrics"]
    model = TextDetector(
        detector_id="lyrics",
        checkpoint=args.base
        / "c2-latency-20260925/models/ots-homr"
        / repo.replace("/", "--")
        / filename,
        revision=revision,
        sha256=digest,
        device="cpu",
    )
    probs = predict_mask(model.model, cv2.imread(str(image_path)), "cpu", batch_size=2)
    classes = probs.argmax(axis=0)
    confidence = probs.max(axis=0)
    from detector_runtime.detector_masks import CLASS_INDEX

    boxes = boxes_from_probs(probs)
    previous = next(
        p
        for p in map(
            json.loads, (prepared / "fusion/pages.jsonl").read_text().splitlines()
        )
        if p["id"] == page["id"]
    )
    old_records = {
        (d["label"], d["left"], d["top"], d["right"], d["bottom"]): d
        for d in previous["rawDetections"]["lyrics"]
    }
    compared = []
    for box in boxes:
        key = (box.label, box.left, box.top, box.right, box.bottom)
        mask = (
            classes[box.top : box.bottom, box.left : box.right]
            == CLASS_INDEX[box.label]
        )
        legacy = float(
            confidence[box.top : box.bottom, box.left : box.right][mask].mean()
        )
        if (
            key not in old_records
            or abs(legacy - old_records[key]["confidence"]) > 1e-6
        ):
            raise ValueError(
                f"Probabilities/geometry did not reproduce frozen baseline: {key}"
            )
        compared.append(
            {
                "label": box.label,
                "box": list(key[1:]),
                "legacyScore": legacy,
                "componentScore": box.confidence,
                "crossesPoint5": (legacy >= 0.5) != (box.confidence >= 0.5),
            }
        )
    if len(compared) != len(old_records):
        raise ValueError("Box count differs from frozen baseline")
    target = [1143, 646, 1248, 688]
    hits = [
        r
        for r in compared
        if r["label"] == "Lyrics"
        and min(target[2], r["box"][2]) > max(target[0], r["box"][0])
        and min(target[3], r["box"][3]) > max(target[1], r["box"][1])
    ]
    changed = [
        r for r in compared if abs(r["componentScore"] - r["legacyScore"]) > 1e-7
    ]
    source = Path(__file__).resolve().parent
    report = {
        "scope": "Same-probability component score audit on one inspected prepared page; no calibration/threshold/accuracy promotion",
        "page": page["id"],
        "modelSha256": digest,
        "imageSha256": sha(image_path),
        "runnerSha256": sha(Path(__file__)),
        "inferenceSourceSha256": sha(source / "detector_runtime/detector_inference.py"),
        "probabilitySha256": hashlib.sha256(probs.tobytes()).hexdigest(),
        "boxCount": len(compared),
        "changedScoreCount": len(changed),
        "thresholdCrossingCount": sum(r["crossesPoint5"] for r in compared),
        "kissedHits": hits,
        "changedBoxes": changed,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    if (args.out / "report.json").exists():
        raise ValueError("Preserve completed audit")
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: report[k]
                for k in [
                    "boxCount",
                    "changedScoreCount",
                    "thresholdCrossingCount",
                    "kissedHits",
                ]
            }
        )
    )


if __name__ == "__main__":
    main()
