"""Measure warm C2 page latency through the pinned production inference classes.

Run inside a staging copy of the Modal image (or an equivalent GPU environment),
with HF_TOKEN read-scoped and real local PNG/JPEG pages. Does not call production,
deploy, upload, or change any model. The extra detector is timed on the same bytes
as the current single-detector + core path. It excludes the future fusion
calibration/geometry pass and HTTP/cold-start overhead. Page failures are
recorded; at least 20 successful paired pages are needed for the latency gate.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path


def percentile(values: list[float], fraction: float) -> float:
    """Use the conservative higher-sample quantile (p95 is the maximum at n=20)."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("No pages were measured")
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction + 0.999999))]


def prepare_runtime(cuda_lib_dirs: list[Path], extra_site_packages: list[Path]) -> None:
    """Set up an existing GPU environment without modifying its shared venv."""
    for path in [*cuda_lib_dirs, *extra_site_packages]:
        if not path.is_dir():
            raise ValueError(f"Runtime directory does not exist: {path}")
    if cuda_lib_dirs:
        prefix = [str(path.resolve()) for path in cuda_lib_dirs]
        current = os.environ.get("LD_LIBRARY_PATH", "").split(os.pathsep)
        if current[: len(prefix)] != prefix:
            env = os.environ.copy()
            env["LD_LIBRARY_PATH"] = os.pathsep.join(
                prefix + [entry for entry in current if entry and entry not in prefix]
            )
            # The ELF loader reads LD_LIBRARY_PATH at process startup. Re-exec
            # before importing ONNX Runtime rather than changing it in-process.
            os.execve(sys.executable, [sys.executable, *sys.argv], env)
    for path in extra_site_packages:
        resolved = str(path.resolve())
        if resolved not in sys.path:
            sys.path.append(resolved)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pages", nargs="+", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--artifact-root", type=Path, default=Path("/models/ots-homr"))
    parser.add_argument("--homr-root", type=Path, default=Path("/opt/homr"))
    parser.add_argument("--cuda-lib-dir", action="append", type=Path, default=[],
                        help="Existing CUDA/cuDNN library directory; may be repeated")
    parser.add_argument("--extra-site-packages", action="append", type=Path, default=[],
                        help="Append missing packages after the active venv; may be repeated")
    args = parser.parse_args()
    if len(args.pages) < 20:
        parser.error("At least 20 real pages are required for a useful p95")
    if len(set(args.pages)) != len(args.pages):
        parser.error("Benchmark pages must be unique")
    if any(path.stem.endswith("_teaser") for path in args.pages):
        parser.error("Use full-resolution pages, not teaser variants")

    prepare_runtime(args.cuda_lib_dir, args.extra_site_packages)
    from bootstrap import bootstrap
    from homr_core import PatchedHomrCore
    from ots_engine import OtsHomrEngine

    artifacts = bootstrap(root=args.artifact_root, device="cuda")
    core = PatchedHomrCore(artifacts=artifacts, homr_root=args.homr_root)
    engine = OtsHomrEngine(artifacts=artifacts, core=core)
    try:
        engine.warm_up()
    except Exception:
        engine.shutdown()
        raise
    samples = []
    failures = []
    try:
        for path in args.pages:
            content_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
                parser.error(f"Unsupported page format: {path}")
            page = path.read_bytes()
            started = time.monotonic()
            try:
                engine.transcribe(page, content_type, False, "non-lyric-text")
            except Exception as error:
                failures.append({
                    "page": str(path), "stage": "baseline",
                    "errorType": type(error).__name__, "error": str(error),
                    "errorCode": getattr(error, "code", None),
                    "detail": str(getattr(core._plain, "_last_error", ""))[:500],
                    "secondsBeforeFailure": round(time.monotonic() - started, 3),
                })
                print(json.dumps(failures[-1]), flush=True)
                continue
            baseline = time.monotonic() - started
            started = time.monotonic()
            try:
                artifacts.detectors["lyrics"].detect(page)
            except Exception as error:
                failures.append({
                    "page": str(path), "stage": "extra-lyrics",
                    "errorType": type(error).__name__, "error": str(error),
                    "secondsBeforeFailure": round(time.monotonic() - started, 3),
                })
                print(json.dumps(failures[-1]), flush=True)
                continue
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
        "attemptedPages": len(args.pages),
        "pageCount": len(samples),
        "failedPages": len(failures),
        "latencyGateEligible": len(samples) >= 20,
        "p95Method": "higher-sample: ceil((n-1)*0.95); maximum at n=20",
        "hardTimeoutSeconds": 280,
        "p50Seconds": {
            "baseline": statistics.median(baselines) if baselines else None,
            "extraLyrics": statistics.median(extras) if extras else None,
            "twoDetector": statistics.median(totals) if totals else None,
        },
        "p95Seconds": {
            "baseline": percentile(baselines, 0.95) if baselines else None,
            "extraLyrics": percentile(extras, 0.95) if extras else None,
            "twoDetector": percentile(totals, 0.95) if totals else None,
        },
        "headroomAtP95Seconds": 280 - percentile(totals, 0.95) if totals else None,
        "samples": samples,
        "failures": failures,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in {"samples", "failures"}}, indent=2))


if __name__ == "__main__":
    main()
