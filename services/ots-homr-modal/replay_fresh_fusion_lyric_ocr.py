"""Run production lyric OCR on freshly pinned e2 detector selections, without labels."""

import argparse
import json
import time
from pathlib import Path

from qualify_frozen_lyric_pages import inventory, sha


def main():
    import cv2
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--fusion", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    pool = inventory([args.base / "fusion-lyrics-test-20261008/pages.jsonl"])
    fused = inventory([args.fusion])
    here = Path(__file__).resolve().parent
    binding = {
        str(p): sha(p)
        for p in [
            Path(__file__),
            args.fusion,
            here / "lyric_ocr.py",
            here / "semantic_gate.py",
            here / "models/semantic-lyrics-v1.json",
        ]
    }
    for key, page in fused.items():
        if (
            page["image_sha256"] != pool[key]["image_sha256"]
            or sha(pool[key]["image"]) != page["image_sha256"]
        ):
            raise ValueError("Fresh detector image identity mismatch")
    args.out.mkdir(parents=True, exist_ok=True)
    identity = args.out / "input-binding.json"
    if identity.exists() and json.loads(identity.read_text()) != binding:
        raise ValueError("Resume inputs or source changed")
    identity.write_text(json.dumps(binding, indent=2) + "\n")
    rows_path = args.out / "rows.jsonl"
    done = inventory([rows_path]) if rows_path.exists() else {}
    if set(done) - set(fused):
        raise ValueError("Unexpected resumed page IDs")
    pipeline = LyricTextPipeline(SemanticGate.load(), threads=2)
    with rows_path.open("a") as output:
        for key, page in fused.items():
            if key in done:
                continue
            boxes = [
                [b["left"], b["top"], b["right"], b["bottom"]]
                for b in page["rawDetections"]["lyrics"]
                if b["label"] == "Lyrics" and b["confidence"] >= 0.5
            ]
            start = time.monotonic()
            result = pipeline.lyric_rows(cv2.imread(pool[key]["image"]), boxes)
            row = {
                "id": key,
                "score": page["score"],
                "corpus": page["corpus"],
                "image_sha256": page["image_sha256"],
                "ocrSelection": "fresh-pinned-e2-lyrics-at-0.5",
                "rawE2BoxesAtPoint5": len(boxes),
                "seconds": time.monotonic() - start,
                **result,
            }
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
            output.flush()
            done[key] = row
            print(
                f"{len(done)}/{len(fused)} {page['score']} {row['seconds']:.1f}s",
                flush=True,
            )
    (args.out / "completion.json").write_text(
        json.dumps(
            {
                "pages": len(done),
                "rowsSha256": sha(rows_path),
                "inputBindingSha256": sha(identity),
                "selection": "Fresh pinned physical lyrics detector, label Lyrics confidence >=0.5; same production OCR selection independent of fused-region status.",
                "scope": "Exact fresh OCR/semantic stage; no attachment accuracy or GPU latency claim",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
