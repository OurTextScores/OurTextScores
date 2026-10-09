"""CPU collection of direction/dynamic candidate rows on fresh Lieder pages, using the shipped selector.

Runs the pinned RapidOCR + frozen semantic gate over the whole page and applies `direction_text.direction_rows`
exactly as the provider does (no e2 lyric regions here: rows the gate calls lyrics are simply not offered).
Pages are one random page per fresh score, chosen with a fixed seed from scores no earlier evaluation mentions.
"""

import argparse
import hashlib
import json
import random
import time
from pathlib import Path

PAGES = Path("/home/jhlusko/workspace/homr-artifacts/datasets/lieder_vocal_text/pages")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scores", type=Path, required=True, help="text file of fresh score ids")
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20261008)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    import cv2
    from direction_text import direction_rows
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    scores = sorted(args.scores.read_text().split())
    rng = random.Random(args.seed)
    chosen = rng.sample(scores, args.count)
    picks = []
    for score in chosen:
        pages = sorted((PAGES / score).glob("*.png"))
        if pages:
            picks.append(rng.choice(pages))
    pipeline = LyricTextPipeline(SemanticGate.load(), threads=4)
    args.out.mkdir(parents=True, exist_ok=True)
    result = args.out / "pages.jsonl"
    done = {json.loads(line)["image"] for line in result.read_text().splitlines()} if result.exists() else set()
    with result.open("a") as handle:
        for path in picks:
            if str(path) in done:
                continue
            start = time.monotonic()
            image = cv2.imread(str(path))
            rows = []
            for raw in pipeline.read_page(image):
                xs, ys = [p[0] for p in raw["box"]], [p[1] for p in raw["box"]]
                verdict = pipeline.gate.classify(raw["text"])
                rows.append(
                    {
                        "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
                        "text": raw["text"],
                        "ocrConfidence": raw["confidence"],
                        "semantic": verdict["prediction"],
                        "semanticScore": verdict["score"],
                        "proposedLyric": verdict["proposedLyric"],
                    }
                )
            offered = direction_rows(rows, [])
            record = {
                "image": str(path),
                "score": path.parent.name,
                "imageSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": [image.shape[1], image.shape[0]],
                "ocrRows": len(rows),
                "directionRows": offered["rows"],
                "rowsOmitted": offered["rowsOmitted"],
                "seconds": time.monotonic() - start,
            }
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            print(f"{path.parent.name}/{path.name}: ocr={len(rows)} offered={len(offered['rows'])} {record['seconds']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
