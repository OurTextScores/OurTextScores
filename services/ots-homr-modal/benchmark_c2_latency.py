"""Measure warm C2 page latency through the pinned production inference classes.

Run inside a staging copy of the Modal image (or an equivalent GPU environment),
with HF_TOKEN read-scoped and real local PNG/JPEG pages. Does not call production,
deploy, upload, or change any model. The extra detector is timed on the same bytes
as the current single-detector + core path.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from bootstrap import bootstrap
from homr_core import PatchedHomrCore
from ots_engine import OtsHomrEngine


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("No pages were measured")
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction + 0.999999))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pages", nargs="+", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--artifact-root", type=Path, default=Path("/models/ots-homr"))
    parser.add_argument("--homr-root", type=Path, default=Path("/opt/homr"))
    args = parser.parse_args()
    if len(args.pages) < 20:
        parser.error("At least 20 real pages are required for a useful p95")

    artifacts = bootstrap(root=args.artifact_root, device="cuda")
    core = PatchedHomrCore(artifacts=artifacts, homr_root=args.homr_root)
    engine = OtsHomrEngine(artifacts=artifacts, core=core)
    engine.warm_up()
    samples = []
    try:
        for path in args.pages:
            content_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                parser.error(f"Unsupported page format: {path}")
            page = path.read_bytes()
            started = time.monotonic()
            engine.transcribe(page, content_type, False, "non-lyric-text")
            baseline = time.monotonic() - started
            started = time.monotonic()
            artifacts.detectors["lyrics"].detect(page)
            extra = time.monotonic() - started
            samples.append({
                "page": str(path),
                "baselineSeconds": round(baseline, 3),
                "extraLyricsSeconds": round(extra, 3),
                "twoDetectorSeconds": round(baseline + extra, 3),
            })
            print(json.dumps(samples[-1]), flush=True)
    finally:
        engine.shutdown()

    totals = [row["twoDetectorSeconds"] for row in samples]
    baselines = [row["baselineSeconds"] for row in samples]
    extras = [row["extraLyricsSeconds"] for row in samples]
    report = {
        "path": "OtsHomrEngine.transcribe(non-lyric-text) + pinned lyrics detector.detect",
        "mode": "warm-inference; serial; same-page-bytes; no HTTP or cold start",
        "pageCount": len(samples),
        "hardTimeoutSeconds": 280,
        "p50Seconds": {
            "baseline": statistics.median(baselines),
            "extraLyrics": statistics.median(extras),
            "twoDetector": statistics.median(totals),
        },
        "p95Seconds": {
            "baseline": percentile(baselines, 0.95),
            "extraLyrics": percentile(extras, 0.95),
            "twoDetector": percentile(totals, 0.95),
        },
        "headroomAtP95Seconds": 280 - percentile(totals, 0.95),
        "samples": samples,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "samples"}, indent=2))


if __name__ == "__main__":
    main()
