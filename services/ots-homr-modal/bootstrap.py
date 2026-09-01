"""Download and verify every private OTS-HOMR runtime input before serving."""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from huggingface_hub import hf_hub_download

from detector_runtime.runtime import TextDetector
from runtime_identity import load_structured_manifest, require_artifact

CORE_REPOSITORY = "jhlusko/OTS-homr"
CORE_REVISION = "1dbc87399c70238136da0dfd412fff032d17b76c"
CORE_ARTIFACT_SHA256 = "1b2855ce3facea9aa8b0017f6e30143abd9aa43569a2f9ce1ab46bf8bf818fa3"
CORE_SHA256 = {
    "encoder.onnx": "f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1",
    "decoder.onnx": "7abc3ea71caac8f5a4fd9a96f0ce40c9f3b224ff83ed05899eae735c9917a1b4",
}
DETECTORS = {
    "lyrics": ("jhlusko/lyrics", "1bf2201d2eead54f78d79e2beba502b204614a92", "lyrics.pth", "7ff21020d5fefe5b774af71dd50610d1b05011f040c4b2c9c58f249b43f39804"),
    "non-lyric-text": ("jhlusko/non-lyric-text", "9073adb53d901c90419f63b0f7e3fb4372ed18cc", "non-lyric-text.pth", "fcb8ca529fa355b0427112bda1c4edd95b2d6cc6c369be0c32f3313987a4ec82"),
}
HEADS_REPOSITORY = "jhlusko/OTS-homr-additonal-heads"
HEADS_REVISION = "4cf9f48672cf8f3563e14ebdec6e2ef2e3ddef13"
HEADS_SHA256 = "75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2"
MANIFEST_SHA256 = "7f92b9b948e6a39daef1f8bcdb66c8ebdfed2c38024ad532f292e0b4d04781fa"
TRAINING_REVISION = "997b70a88c9f945b632f4129b036b2cd0972b2a3"


@dataclass(frozen=True)
class RuntimeArtifacts:
    encoder: Path
    decoder: Path
    heads: Path
    manifest: Path
    detectors: dict[str, TextDetector]


def _download(repo: str, revision: str, filename: str, expected_sha256: str, root: Path) -> Path:
    token = os.environ.get("HF_TOKEN", "")
    if not token:
        raise RuntimeError("HF_TOKEN is required only inside the OTS-HOMR provider")
    path = Path(hf_hub_download(repo, filename, revision=revision, token=token, local_dir=root / repo.replace("/", "--")))
    require_artifact(path, expected_sha256)
    return path


def bootstrap(*, root: Path, device: str) -> RuntimeArtifacts:
    root.mkdir(parents=True, exist_ok=True)
    encoder = _download(CORE_REPOSITORY, CORE_REVISION, "encoder.onnx", CORE_SHA256["encoder.onnx"], root)
    decoder = _download(CORE_REPOSITORY, CORE_REVISION, "decoder.onnx", CORE_SHA256["decoder.onnx"], root)
    manifest = _download(HEADS_REPOSITORY, HEADS_REVISION, "manifest.json", MANIFEST_SHA256, root)
    heads = _download(HEADS_REPOSITORY, HEADS_REVISION, "structured_heads_rareNumMixed.onnx", HEADS_SHA256, root)
    loaded = load_structured_manifest(manifest, expected_sha256=MANIFEST_SHA256, core_training_revision=TRAINING_REVISION)
    if loaded["runtimeArtifacts"]["onnx"].get("sha256") != HEADS_SHA256:
        raise RuntimeError("Structured-head manifest does not match its ONNX artifact")
    detectors = {}
    for detector_id, (repo, revision, filename, digest) in DETECTORS.items():
        checkpoint = _download(repo, revision, filename, digest, root)
        detectors[detector_id] = TextDetector(detector_id=detector_id, checkpoint=checkpoint, revision=revision, sha256=digest, device=device)
    # No subsequent inference path may resolve a moving HF revision.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    return RuntimeArtifacts(encoder=encoder, decoder=decoder, heads=heads, manifest=manifest, detectors=detectors)
