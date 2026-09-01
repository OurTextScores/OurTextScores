"""Composition layer joining rareNum transcription and selected detector policy."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_REVISION,
    CORE_SHA256,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    HEADS_REVISION,
    MANIFEST_SHA256,
)
from runtime_identity import selected_components

if TYPE_CHECKING:
    from bootstrap import RuntimeArtifacts


class OtsHomrEngine:
    """Provider contract engine; the core callable owns patched HOMR decoding."""

    def __init__(
        self,
        *,
        artifacts: RuntimeArtifacts,
        core: Any,
        execution_provider: str = "CUDAExecutionProvider",
    ) -> None:
        self.artifacts = artifacts
        self.core = core
        self.execution_provider = execution_provider
        self._ready = False
        self._warm_lock = threading.Lock()

    def warm_up(self) -> None:
        with self._warm_lock:
            if self._ready and self.core.is_ready():
                return
            if self.execution_provider != "CUDAExecutionProvider":
                raise RuntimeError("OTS-HOMR requires CUDA")
            self.core.warm_up()
            self._ready = self.core.is_ready()
            if not self._ready:
                raise RuntimeError("rareNum core did not become ready")

    def is_ready(self) -> bool:
        return self._ready and self.core.is_ready()

    def transcribe(
        self,
        page: bytes,
        content_type: str,
        detect_title: bool,
        text_detector: str,
        head_mode: str,
    ) -> dict[str, Any]:
        if not self._ready:
            raise RuntimeError("OTS-HOMR engine is not ready")
        # Run the selected detector before core decode so failures are visible
        # under that exact policy; its boxes are private diagnostics for now.
        if text_detector != "none":
            self.artifacts.detectors[text_detector].detect(page)
        return self.core.transcribe(page, content_type, detect_title, head_mode)

    def regenerate(self, staffs: list[list[list[str]]], title: str = "") -> bytes:
        return self.core.regenerate(staffs, title)

    def shutdown(self) -> None:
        with self._warm_lock:
            self.core.shutdown()
            self._ready = False

    def identity(self, text_detector: str, head_mode: str) -> dict[str, Any]:
        detector = self.artifacts.detectors.get(text_detector)
        identity = selected_components(
            core_revision=CORE_REVISION,
            core_sha256=CORE_ARTIFACT_SHA256,
            execution_provider=self.execution_provider,
            text_detector=text_detector,
            detector_revision=detector.revision if detector else None,
            detector_sha256=detector.sha256 if detector else None,
            heads_mode=head_mode,
            heads_revision=HEADS_REVISION if head_mode != "off" else None,
            heads_sha256=HEADS_CHECKPOINT_SHA256 if head_mode != "off" else None,
            manifest_sha256=MANIFEST_SHA256 if head_mode != "off" else None,
        )
        identity["core"]["runtimeArtifacts"] = {
            "encoderOnnxSha256": CORE_SHA256["encoder.onnx"],
            "decoderOnnxSha256": CORE_SHA256["decoder.onnx"],
        }
        if "structuredHeads" in identity:
            identity["structuredHeads"]["runtimeArtifacts"] = {
                "onnxSha256": HEADS_ONNX_SHA256,
            }
        return identity

    def capabilities_identity(self) -> dict[str, Any]:
        """Describe every selectable pinned component, not merely one policy."""
        core = self.identity("none", "off")
        return {
            **core,
            "textDetectors": [
                {
                    "id": detector_id,
                    "revision": detector.revision,
                    "sha256": detector.sha256,
                }
                for detector_id, detector in sorted(self.artifacts.detectors.items())
            ],
            "structuredHeads": {
                "revision": HEADS_REVISION,
                "sha256": HEADS_CHECKPOINT_SHA256,
                "manifestSha256": MANIFEST_SHA256,
                "runtimeArtifacts": {"onnxSha256": HEADS_ONNX_SHA256},
                "compatibleCoreRevision": CORE_REVISION,
                "emittedHeadFamilies": ["beam.level", "advance.delta"],
                "reviewOnlyHeadFamilies": ["stem.direction", "tie", "slur"],
            },
        }
