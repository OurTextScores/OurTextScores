"""Composition layer joining rareNum transcription and selected detector policy."""

from __future__ import annotations

import threading
import hashlib
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from calibration_manifest import CalibrationManifest
from fusion_v1 import fuse_page
from fusion_policy import CLASS_ALLOWLIST
from detector_routes import route_detections

from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_REVISION,
    CORE_SHA256,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    HEADS_REVISION,
    MANIFEST_SHA256,
    DETECTOR_ROUTES,
    FUSION_DETECTORS,
)
from runtime_identity import selected_components

if TYPE_CHECKING:
    from bootstrap import RuntimeArtifacts


class TextFusionError(RuntimeError):
    code = "fusion_failed"

    def __init__(self, stage: str) -> None:
        self.stage = stage
        super().__init__(f"Text fusion failed at {stage}")


class OtsHomrEngine:
    """Provider contract engine; the core callable owns patched HOMR decoding."""

    def __init__(
        self,
        *,
        artifacts: RuntimeArtifacts,
        core: Any,
        execution_provider: str = "CUDAExecutionProvider",
        fusion_manifest: CalibrationManifest | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.core = core
        self.execution_provider = execution_provider
        self.fusion_manifest = fusion_manifest
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
        score_profile: Any = None,
    ) -> dict[str, dict[str, Any]]:
        if not self._ready:
            raise RuntimeError("OTS-HOMR engine is not ready")
        # Run the selected detector before core decode so failures are visible
        # under that exact policy; its boxes are private diagnostics for now.
        if text_detector != "none":
            self.artifacts.detectors[text_detector].detect(page)
        return self.core.transcribe_both(page, content_type, detect_title, score_profile)

    def transcribe_fusion(
        self,
        page: bytes,
        content_type: str,
        detect_title: bool,
        score_profile: Any = None,
    ) -> dict[str, Any]:
        """Run both detectors on identical bytes and return bounded review decisions.

        Missing calibration or either detector fails before a core result can be
        returned. MusicXML stays the core result until recognition and attachment
        have their own held-out release gate.
        """
        if not self._ready:
            raise RuntimeError("OTS-HOMR engine is not ready")
        if self.fusion_manifest is None:
            raise TextFusionError("calibration")
        if self.fusion_manifest.policy != "fusion-v1":
            raise TextFusionError("calibration")
        identities = {}
        for detector_id in FUSION_DETECTORS:
            detector = self.artifacts.detectors.get(detector_id)
            if detector is None:
                raise TextFusionError(f"{detector_id}-detector")
            physical = self.artifacts.detectors.get(DETECTOR_ROUTES[detector_id])
            if physical is None or (physical.revision, physical.sha256) != (detector.revision, detector.sha256):
                raise TextFusionError("calibration")
            identities[detector_id] = (detector.revision, detector.sha256)
            try:
                self.fusion_manifest.assert_detector_matches(
                    detector_id, revision=detector.revision, sha256=detector.sha256
                )
            except Exception as error:
                raise TextFusionError("calibration") from error
            if self.fusion_manifest.class_allowlist.get(detector_id) != CLASS_ALLOWLIST[detector_id]:
                raise TextFusionError("calibration")
        decoded = cv2.imdecode(np.frombuffer(page, dtype=np.uint8), cv2.IMREAD_COLOR)
        if decoded is None:
            raise TextFusionError("fusion")
        height, width = decoded.shape[:2]
        detections = {}
        # Run each physical checkpoint once, then partition its class outputs.
        for detector_id in dict.fromkeys(DETECTOR_ROUTES.values()):
            try:
                detections[detector_id] = self.artifacts.detectors[detector_id].detect(page)
            except Exception as error:
                raise TextFusionError(f"{detector_id}-detector") from error
        try:
            fusion = fuse_page(
                page_sha256=hashlib.sha256(decoded.tobytes()).hexdigest(),
                page_size=(width, height),
                detections=route_detections(detections),
                detector_identities=identities,
                manifest=self.fusion_manifest,
            )
        except Exception as error:
            raise TextFusionError("fusion") from error
        try:
            result = self.core.transcribe_both(page, content_type, detect_title, score_profile)
        except Exception as error:
            raise TextFusionError("recognition") from error
        result["fusion"] = fusion
        return result

    def regenerate(self, staffs: list[list[list[str]]], title: str = "") -> bytes:
        return self.core.regenerate(staffs, title)

    def materialize_structured(
        self,
        staffs: list[list[list[str]]],
        structured: list[list[dict[str, Any] | None]],
        families: list[str],
        title: str = "",
    ) -> bytes:
        return self.core.materialize_structured(staffs, structured, families, title)

    def shutdown(self) -> None:
        with self._warm_lock:
            self.core.shutdown()
            self._ready = False

    def identity(self, text_detector: str) -> dict[str, Any]:
        fusion = text_detector == "fusion-v1"
        if fusion and self.fusion_manifest is None:
            raise RuntimeError("fusion-v1 calibration is unavailable")
        detector = self.artifacts.detectors.get(text_detector)
        identity = selected_components(
            core_revision=CORE_REVISION,
            core_sha256=CORE_ARTIFACT_SHA256,
            execution_provider=self.execution_provider,
            text_detector="none" if fusion else text_detector,
            detector_revision=detector.revision if detector else None,
            detector_sha256=detector.sha256 if detector else None,
            heads_mode="both",
            heads_revision=HEADS_REVISION,
            heads_sha256=HEADS_CHECKPOINT_SHA256,
            manifest_sha256=MANIFEST_SHA256,
        )
        identity["core"]["runtimeArtifacts"] = {
            "encoderOnnxSha256": CORE_SHA256["encoder.onnx"],
            "decoderOnnxSha256": CORE_SHA256["decoder.onnx"],
        }
        identity["structuredHeads"]["runtimeArtifacts"] = {
            "onnxSha256": HEADS_ONNX_SHA256,
        }
        if fusion:
            identity["textPolicy"] = {
                "mode": "fusion-v1",
                "fusionRevision": "fusion-v1",
                "calibrationRevision": self.fusion_manifest.policy_revision,
                "detectors": [
                    {
                        "id": detector_id,
                        "revision": self.artifacts.detectors[detector_id].revision,
                        "sha256": self.artifacts.detectors[detector_id].sha256,
                    }
                    for detector_id in FUSION_DETECTORS
                ],
            }
        return identity

    def capabilities_identity(self) -> dict[str, Any]:
        """Describe every selectable pinned component, not merely one policy."""
        core = self.identity("none")
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
            "textPolicies": ["fusion-v1"] if self.fusion_manifest else [],
            "structuredHeads": {
                "revision": HEADS_REVISION,
                "sha256": HEADS_CHECKPOINT_SHA256,
                "manifestSha256": MANIFEST_SHA256,
                "runtimeArtifacts": {"onnxSha256": HEADS_ONNX_SHA256},
                "compatibleCoreRevision": CORE_REVISION,
                "emittedHeadFamilies": [
                    "beam.level",
                    "advance.delta",
                    "stem.direction",
                    "tie",
                    "slur",
                ],
            },
        }
