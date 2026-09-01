"""Immutable artifact and policy identity for the OTS-HOMR Modal runtime."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class RuntimeIdentityError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_artifact(path: Path, expected_sha256: str) -> None:
    if not path.is_file() or sha256_file(path) != expected_sha256:
        raise RuntimeIdentityError(f"Pinned artifact verification failed: {path.name}")


def load_structured_manifest(path: Path, *, expected_sha256: str, core_training_revision: str) -> dict[str, Any]:
    require_artifact(path, expected_sha256)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeIdentityError("Structured-head manifest is invalid") from error
    if manifest.get("schemaVersion") != "homr.capability-manifest.v1":
        raise RuntimeIdentityError("Unsupported structured-head manifest")
    if manifest.get("trainingRevision") != core_training_revision:
        raise RuntimeIdentityError("Structured heads are incompatible with the rareNum core")
    artifact = (manifest.get("runtimeArtifacts") or {}).get("onnx") or {}
    if artifact.get("filename") != "structured_heads_rareNumMixed.onnx":
        raise RuntimeIdentityError("Structured-head ONNX artifact is not declared")
    return manifest


def selected_components(
    *,
    core_revision: str,
    core_sha256: str,
    execution_provider: str,
    text_detector: str,
    detector_revision: str | None = None,
    detector_sha256: str | None = None,
    heads_mode: str = "off",
    heads_revision: str | None = None,
    heads_sha256: str | None = None,
    manifest_sha256: str | None = None,
) -> dict[str, Any]:
    """Return exactly the envelope validated by the Scanner adapter."""
    result: dict[str, Any] = {
        "core": {"repository": "jhlusko/OTS-homr", "revision": core_revision, "sha256": core_sha256},
        "executionProvider": execution_provider,
    }
    if text_detector != "none":
        if not detector_revision or not detector_sha256:
            raise RuntimeIdentityError("Selected detector identity is incomplete")
        result["textDetector"] = {"id": text_detector, "revision": detector_revision, "sha256": detector_sha256}
    if heads_mode != "off":
        if not all((heads_revision, heads_sha256, manifest_sha256)):
            raise RuntimeIdentityError("Selected structured-head identity is incomplete")
        result["structuredHeads"] = {
            "mode": heads_mode,
            "revision": heads_revision,
            "sha256": heads_sha256,
            "manifestSha256": manifest_sha256,
            "compatibleCoreRevision": core_revision,
            "emittedHeadFamilies": ["beam.level", "advance.delta"] if heads_mode == "experimental-output" else [],
        }
    return result
