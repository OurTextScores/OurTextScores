"""Local CPU replay of both pinned physical detectors and all fusion-v1 routes."""

import argparse
import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path

from qualify_frozen_lyric_pages import inventory, sha


def main():
    import cv2
    import torch
    from calibration_manifest import load_calibration_manifest
    from detector_routes import route_detections
    from detector_runtime.runtime import TextDetector
    from fusion_v1 import fuse_page
    from pins import DETECTOR_ROUTES, DETECTORS

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    here = Path(__file__).resolve().parent
    selected_path = (
        args.base / "lyric-native-reference-readiness-20261008-v3/candidate-pages.json"
    )
    pool_path = args.base / "fusion-lyrics-test-20261008/pages.jsonl"
    pages = json.loads(selected_path.read_text()) + [
        p for p in inventory([pool_path]).values() if p["corpus"] == "ossq"
    ]
    manifest_path = here / "calibration/fusion-v1.json"
    manifest = load_calibration_manifest(manifest_path)
    model_root = args.base / "c2-latency-20260925/models/ots-homr"
    args.out.mkdir(parents=True, exist_ok=True)
    binding = {
        str(p): sha(p)
        for p in [
            Path(__file__),
            selected_path,
            pool_path,
            manifest_path,
            *sorted((here / "detector_runtime").glob("*.py")),
            here / "fusion_v1.py",
            here / "fusion_policy.py",
            here / "detector_routes.py",
            here / "calibration_manifest.py",
            here / "pins.py",
        ]
    }
    for page in pages:
        if sha(page["image"]) != page["image_sha256"]:
            raise ValueError("image checksum mismatch")
        binding[page["image"]] = page["image_sha256"]
    binding_path = args.out / "input-binding.json"
    if binding_path.exists() and json.loads(binding_path.read_text()) != binding:
        raise ValueError("resume input/code changed")
    binding_path.write_text(json.dumps(binding, indent=2) + "\n")
    detectors = {}
    for name, (repository, revision, filename, digest) in DETECTORS.items():
        detectors[name] = TextDetector(
            detector_id=name,
            checkpoint=model_root / repository.replace("/", "--") / filename,
            revision=revision,
            sha256=digest,
            device="cpu",
        )
    identities = {
        logical: (detectors[physical].revision, detectors[physical].sha256)
        for logical, physical in DETECTOR_ROUTES.items()
    }
    result_path = args.out / "pages.jsonl"
    done = inventory([result_path]) if result_path.exists() else {}
    if set(done) - {p["id"] for p in pages}:
        raise ValueError("unexpected resume IDs")
    with result_path.open("a") as handle:
        for page in pages:
            if page["id"] in done:
                continue
            start = time.monotonic()
            image = Path(page["image"]).read_bytes()
            decoded = cv2.imread(page["image"])
            height, width = decoded.shape[:2]
            raw = {
                name: detector.detect(image, batch_size=2)
                for name, detector in detectors.items()
            }
            fusion = fuse_page(
                page_sha256=hashlib.sha256(decoded.tobytes()).hexdigest(),
                page_size=(width, height),
                detections=route_detections(raw),
                detector_identities=identities,
                manifest=manifest,
            )
            record = {
                "id": page["id"],
                "score": page["score"],
                "corpus": page["corpus"],
                "image_sha256": page["image_sha256"],
                "pixel_sha256": hashlib.sha256(decoded.tobytes()).hexdigest(),
                "raster": {"width": width, "height": height},
                "detectorIdentities": identities,
                "rawDetections": raw,
                "fusion": asdict(fusion),
                "seconds": time.monotonic() - start,
            }
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            done[page["id"]] = record
            print(
                f"{len(done)}/{len(pages)} {page['score']} {record['seconds']:.1f}s {fusion.summary}",
                flush=True,
            )
    (args.out / "completion.json").write_text(
        json.dumps(
            {
                "pages": len(done),
                "inputBindingSha256": sha(binding_path),
                "resultsSha256": sha(result_path),
                "scope": "exact pinned detector/fusion CPU replay; no OCR/recognition/attachment or GPU latency qualification",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
