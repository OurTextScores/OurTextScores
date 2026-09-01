"""Download and verify every private OTS-HOMR runtime input before serving."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from detector_runtime.runtime import TextDetector
from huggingface_hub import hf_hub_download
from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_REPOSITORY,
    CORE_REVISION,
    CORE_SHA256,
    DETECTORS,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    HEADS_REPOSITORY,
    HEADS_REVISION,
    MANIFEST_SHA256,
    TRAINING_REVISION,
)
from runtime_identity import load_structured_manifest, require_artifact


@dataclass(frozen=True)
class RuntimeArtifacts:
    core_checkpoint: Path
    encoder: Path
    decoder: Path
    heads_checkpoint: Path
    heads: Path
    manifest: Path
    detectors: dict[str, TextDetector]


def _download(
    repo: str, revision: str, filename: str, expected_sha256: str, root: Path
) -> Path:
    token = os.environ.get("HF_TOKEN", "")
    if not token:
        raise RuntimeError("HF_TOKEN is required only inside the OTS-HOMR provider")
    path = Path(
        hf_hub_download(
            repo,
            filename,
            revision=revision,
            token=token,
            local_dir=root / repo.replace("/", "--"),
        )
    )
    require_artifact(path, expected_sha256)
    return path


def bootstrap(*, root: Path, device: str) -> RuntimeArtifacts:
    root.mkdir(parents=True, exist_ok=True)
    core_checkpoint = _download(
        CORE_REPOSITORY, CORE_REVISION, "OTS-homr.pth", CORE_ARTIFACT_SHA256, root
    )
    encoder = _download(
        CORE_REPOSITORY,
        CORE_REVISION,
        "encoder.onnx",
        CORE_SHA256["encoder.onnx"],
        root,
    )
    decoder = _download(
        CORE_REPOSITORY,
        CORE_REVISION,
        "decoder.onnx",
        CORE_SHA256["decoder.onnx"],
        root,
    )
    manifest = _download(
        HEADS_REPOSITORY, HEADS_REVISION, "manifest.json", MANIFEST_SHA256, root
    )
    heads_checkpoint = _download(
        HEADS_REPOSITORY,
        HEADS_REVISION,
        "OTS-homr-additonal-heads.pth",
        HEADS_CHECKPOINT_SHA256,
        root,
    )
    heads = _download(
        HEADS_REPOSITORY,
        HEADS_REVISION,
        "structured_heads_rareNumMixed.onnx",
        HEADS_ONNX_SHA256,
        root,
    )
    loaded = load_structured_manifest(
        manifest,
        expected_sha256=MANIFEST_SHA256,
        core_training_revision=TRAINING_REVISION,
    )
    if loaded["runtimeArtifacts"]["onnx"].get("sha256") != HEADS_ONNX_SHA256:
        raise RuntimeError("Structured-head manifest does not match its ONNX artifact")
    detectors = {}
    for detector_id, (repo, revision, filename, digest) in DETECTORS.items():
        checkpoint = _download(repo, revision, filename, digest, root)
        detectors[detector_id] = TextDetector(
            detector_id=detector_id,
            checkpoint=checkpoint,
            revision=revision,
            sha256=digest,
            device=device,
        )
    # No subsequent inference path may resolve a moving HF revision.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    return RuntimeArtifacts(
        core_checkpoint=core_checkpoint,
        encoder=encoder,
        decoder=decoder,
        heads_checkpoint=heads_checkpoint,
        heads=heads,
        manifest=manifest,
        detectors=detectors,
    )
