"""Read-only local private-pin preflight; no downloads or inference/deployment."""

import argparse
import hashlib
import json
import time
from pathlib import Path

from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_SHA256,
    DETECTORS,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    MANIFEST_SHA256,
)


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def preflight(root, probe_sessions=False):
    files = {
        "encoder": ("jhlusko--OTS-homr/encoder.onnx", CORE_SHA256["encoder.onnx"]),
        "decoder": ("jhlusko--OTS-homr/decoder.onnx", CORE_SHA256["decoder.onnx"]),
        "core-checkpoint": ("jhlusko--OTS-homr/OTS-homr.pth", CORE_ARTIFACT_SHA256),
        "heads": (
            "jhlusko--OTS-homr-additonal-heads/structured_heads_rareNumMixed.onnx",
            HEADS_ONNX_SHA256,
        ),
        "heads-checkpoint": (
            "jhlusko--OTS-homr-additonal-heads/OTS-homr-additonal-heads.pth",
            HEADS_CHECKPOINT_SHA256,
        ),
        "heads-manifest": (
            "jhlusko--OTS-homr-additonal-heads/manifest.json",
            MANIFEST_SHA256,
        ),
        **{
            role: (f"{repo.replace('/', '--')}/{name}", digest)
            for role, (repo, revision, name, digest) in DETECTORS.items()
        },
    }
    report = {
        "scope": "Read-only private model inventory and optional CPU session construction; no page inference or CUDA/full-fusion qualification",
        "files": {},
        "sessions": {},
        "sourceSha256": sha(Path(__file__)),
        "pinsSha256": sha(Path(__file__).with_name("pins.py")),
        "fusionManifestCheckedPath": str(
            Path(__file__).parent / "calibration/fusion-v1.json"
        ),
        "fusionManifestPresent": (
            Path(__file__).parent / "calibration/fusion-v1.json"
        ).exists(),
    }
    for role, (relative, expected) in files.items():
        path = root / relative
        actual = sha(path) if path.is_file() else None
        report["files"][role] = {
            "path": str(path),
            "expectedSha256": expected,
            "actualSha256": actual,
            "verified": actual == expected,
        }
    if probe_sessions:
        import onnxruntime as ort

        report["onnxruntime"] = ort.__version__
        report["availableProviders"] = ort.get_available_providers()
        for role in ("encoder", "decoder", "heads"):
            if not report["files"][role]["verified"]:
                continue
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            started = time.monotonic()
            try:
                session = ort.InferenceSession(
                    report["files"][role]["path"],
                    sess_options=options,
                    providers=["CPUExecutionProvider"],
                )
                report["sessions"][role] = {
                    "loaded": True,
                    "seconds": time.monotonic() - started,
                    "providers": session.get_providers(),
                    "inputs": [
                        {"name": node.name, "type": node.type, "shape": node.shape}
                        for node in session.get_inputs()
                    ],
                }
                del session
            except Exception as exc:  # noqa: BLE001
                # Preserve optional provider/session probe failures in the report.
                report["sessions"][role] = {
                    "loaded": False,
                    "seconds": time.monotonic() - started,
                    "error": str(exc),
                }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-root", required=True, type=Path)
    parser.add_argument("--probe-sessions", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = preflight(args.models_root, args.probe_sessions)
    with args.output.open("x") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
