"""Run the pinned non-lyric (e4) detector on each scanner job's recognition raster and keep its Dynamic boxes.

The boxes are in the raster's own coordinates, the same ones the recognised staves and bar lines use, so a box
can be assigned to a staff and measure without any rescaling. Development tooling for the dynamics classifier.
"""

import argparse
import json
import time
import urllib.request
from pathlib import Path

MODEL_ROOT = Path("/home/jhlusko/workspace/homr-artifacts/gpu-roadmap-20260919/instance-results/workspace/c2-latency-20260925/models/ots-homr")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    import torch
    from detector_runtime.runtime import TextDetector
    from pins import DETECTORS

    torch.set_num_threads(4)
    repository, revision, filename, digest = DETECTORS["non-lyric-text"]
    detector = TextDetector(detector_id="non-lyric-text", checkpoint=MODEL_ROOT / repository.replace("/", "--") / filename, revision=revision, sha256=digest, device="cpu")
    args.out.mkdir(parents=True, exist_ok=True)
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        target = args.out / f"{job['jobId']}.json"
        if target.exists():
            continue
        request = urllib.request.Request(f"{args.api}/{job['jobId']}/pages/1/lyric-candidates/scan", headers={"Authorization": f"Bearer {args.token}"})
        raster = urllib.request.urlopen(request, timeout=120).read()
        (args.out / f"{job['jobId']}.png").write_bytes(raster)
        start = time.monotonic()
        boxes = [b for b in detector.detect(raster, batch_size=2) if b["label"] == "Dynamic"]
        target.write_text(json.dumps({"image": job["image"], "jobId": job["jobId"], "dynamicBoxes": boxes, "seconds": time.monotonic() - start}))
        print(job["image"].split("/")[-1], len(boxes), f"{time.monotonic() - start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
