"""Full-page OCR rows (RapidOCR + semantic gate) for the recognition rasters saved by run_e4_on_rasters.py."""

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rasters", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import cv2
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    pipeline = LyricTextPipeline(SemanticGate.load(), threads=4)
    for png in sorted(args.rasters.glob("*.png")):
        target = png.with_suffix(".ocr.json")
        if target.exists():
            continue
        rows = []
        for raw in pipeline.read_page(cv2.imread(str(png))):
            xs, ys = [p[0] for p in raw["box"]], [p[1] for p in raw["box"]]
            verdict = pipeline.gate.classify(raw["text"])
            rows.append({"box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))], "text": raw["text"], "conf": raw["confidence"], "semantic": verdict["prediction"]})
        target.write_text(json.dumps(rows))
        print(png.stem[:8], len(rows), flush=True)


if __name__ == "__main__":
    main()
