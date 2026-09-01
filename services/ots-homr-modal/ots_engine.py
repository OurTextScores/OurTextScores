"""Composition layer joining rareNum transcription and selected detector policy."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from bootstrap import CORE_ARTIFACT_SHA256, CORE_REVISION, HEADS_REVISION, HEADS_SHA256, MANIFEST_SHA256, RuntimeArtifacts
from runtime_identity import selected_components


class OtsHomrEngine:
    """Provider contract engine; the core callable owns patched HOMR decoding."""

    def __init__(self, *, artifacts: RuntimeArtifacts, core_transcribe: Callable[[bytes, str, bool, str], bytes], execution_provider: str = "CUDAExecutionProvider") -> None:
        self.artifacts = artifacts
        self.core_transcribe = core_transcribe
        self.execution_provider = execution_provider
        self._ready = False

    def warm_up(self) -> None:
        if self.execution_provider != "CUDAExecutionProvider":
            raise RuntimeError("OTS-HOMR requires CUDA")
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def transcribe(self, page: bytes, content_type: str, detect_title: bool, text_detector: str, head_mode: str) -> bytes:
        if not self._ready:
            raise RuntimeError("OTS-HOMR engine is not ready")
        # Run the selected detector before core decode so failures are visible
        # under that exact policy; its boxes are private diagnostics for now.
        if text_detector != "none":
            self.artifacts.detectors[text_detector].detect(page)
        return self.core_transcribe(page, content_type, detect_title, head_mode)

    def identity(self, text_detector: str, head_mode: str) -> dict[str, Any]:
        detector = self.artifacts.detectors.get(text_detector)
        return selected_components(
            core_revision=CORE_REVISION,
            core_sha256=CORE_ARTIFACT_SHA256,
            execution_provider=self.execution_provider,
            text_detector=text_detector,
            detector_revision=detector.revision if detector else None,
            detector_sha256=detector.sha256 if detector else None,
            heads_mode=head_mode,
            heads_revision=HEADS_REVISION if head_mode != "off" else None,
            heads_sha256=HEADS_SHA256 if head_mode != "off" else None,
            manifest_sha256=MANIFEST_SHA256 if head_mode != "off" else None,
        )
