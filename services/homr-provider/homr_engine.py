"""Warm, supervised HOMR inference for the OurTextScores Scanner providers.

Design reference: SCANNER_PAGE_HOMR_DESIGN_2026-08-06.md sections 2.2, 9.2, 9.3.

HOMR caches its ONNX sessions in process-level globals, so spawning a fresh
`homr` process per page throws away every warm session. This module keeps one
long-lived child process that owns those sessions and answers one request at a
time, while the parent stays free to enforce a hard wall-clock timeout: an
`asyncio` timeout cannot interrupt native ONNX/OpenCV work, but killing the
child can. A killed child is replaced on the next request.
"""

from __future__ import annotations

import hashlib
import multiprocessing
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Stable provider-side failure codes. These map onto the HTTP taxonomy in
# design section 9.4 and, through it, onto the OTS retry classification in 13.1.
CODE_NO_STAFF = "no_staff_detected"
CODE_INVALID_IMAGE = "invalid_image"
CODE_TIMEOUT = "inference_timeout"
CODE_FAILED = "inference_failed"
CODE_NOT_READY = "model_not_ready"

# Messages HOMR raises when the image decoded fine but holds no usable notation
# (homr/main.py, `No noteheads found` and `No staffs found`). Verified against
# the pinned commit with a blank page; keep in step when repinning HOMR.
_NO_NOTATION_MARKERS = ("No staffs found", "No noteheads found")


def classify_homr_error(text: str) -> str:
    """Map a HOMR exception message onto a stable provider code.

    Getting this wrong is expensive in both directions: a deterministic failure
    classified as `inference_failed` becomes a retryable 500 and OTS burns a
    second provider call on a page that can never succeed, while an
    infrastructure failure classified as deterministic is hidden as a bad page.
    """
    if any(marker in text for marker in _NO_NOTATION_MARKERS):
        return CODE_NO_STAFF
    if "Failed to read" in text:
        return CODE_INVALID_IMAGE
    return CODE_FAILED


class InferenceError(RuntimeError):
    """A classified inference failure carrying a stable code."""

    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # `detail` is for provider-side logs only. It must never be returned to
        # the caller: it can contain HOMR stack traces and local paths.
        self.detail = detail


@dataclass
class EngineProvenance:
    """Exact identity of the code and weights that produced a result."""

    homr_commit: str = ""
    execution_provider: str = ""
    available_execution_providers: list[str] = field(default_factory=list)
    segmentation_model: str = ""
    segmentation_model_sha256: str = ""
    transformer_model: str = ""
    encoder_model_sha256: str = ""
    decoder_model_sha256: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "homrCommit": self.homr_commit,
            "executionProvider": self.execution_provider,
            "availableExecutionProviders": list(self.available_execution_providers),
            "segmentationModel": self.segmentation_model,
            "segmentationModelSha256": self.segmentation_model_sha256,
            "transformerModel": self.transformer_model,
            "encoderModelSha256": self.encoder_model_sha256,
            "decoderModelSha256": self.decoder_model_sha256,
        }


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return ""
    return digest.hexdigest()


WARMUP_PAGE = Path(__file__).resolve().parent / "warmup-page.png"


def _warmup_page() -> bytes:
    """The page used to warm every model at startup (design section 9.3).

    `warmup-page.png` is `warmup-page.musicxml` — a four-bar C major scale
    written for this purpose — engraved with MuseScore and scaled to the 1,920 px
    working width. HOMR recognises it (4 measures, 12 notes), so the warm-up
    exercises segmentation, staff detection, *and* transformer decoding rather
    than stopping at the first stage. It carries no third-party rights.

    Falls back to a crude generated staff if the fixture is ever missing; that
    fallback usually yields no staff, which the engine reports as degraded.
    """
    if WARMUP_PAGE.is_file():
        return WARMUP_PAGE.read_bytes()
    return _synthetic_warmup_page()


def _synthetic_warmup_page() -> bytes:
    """Last-resort generated staff when the bundled fixture is unavailable."""
    import cv2  # imported in the child, where OpenCV is installed
    import numpy as np

    width, height = 1920, 640
    page = np.full((height, width), 255, dtype=np.uint8)
    left, right = 160, width - 160
    for system in (0, 1):
        top = 150 + system * 240
        for line in range(5):
            y = top + line * 22
            cv2.line(page, (left, y), (right, y), 0, 3)
        # Note-like blobs so symbol segmentation and the transformer both run.
        for index in range(12):
            x = left + 120 + index * 130
            y = top + 22 * (index % 5)
            cv2.ellipse(page, (x, y), (13, 9), 0, 0, 360, 0, -1)
            cv2.line(page, (x + 12, y), (x + 12, y - 70), 0, 3)
    ok, encoded = cv2.imencode(".png", page)
    if not ok:
        raise RuntimeError("Unable to encode the warm-up page")
    return bytes(encoded.tobytes())


def _child_main(connection: Any, use_gpu: bool) -> None:
    """Long-lived inference loop. Owns the cached ONNX sessions."""
    warnings: list[str] = []
    try:
        import onnxruntime as ort

        from homr.main import ProcessingConfig, download_weights, process_image
        from homr.music_xml_generator import XmlGeneratorArguments
        from homr.segmentation.config import (
            model_name as segnet_model_name,
            segnet_path_onnx,
            segnet_path_onnx_fp16,
        )
        from homr.title_detection import download_ocr_weights
        from homr.transformer.configs import default_config

        ort.set_default_logger_severity(3)
        # The images bake the weights in, so this verifies rather than downloads.
        download_weights(use_gpu, use_gpu, False)
        try:
            # Title detection is opt-in per page and RapidOCR caches outside the
            # HOMR package, which a read-only rootfs may refuse. Warming it is
            # worth doing but must not be able to hold back readiness for the
            # segmentation and transformer models, which is what pages need.
            download_ocr_weights()
        except Exception as error:
            warnings.append(f"OCR warm-up unavailable: {error!r}"[:500])

        paths = default_config.filepaths
        provenance = EngineProvenance(
            available_execution_providers=list(ort.get_available_providers()),
            segmentation_model=segnet_model_name,
            segmentation_model_sha256=_sha256_file(
                segnet_path_onnx_fp16 if use_gpu else segnet_path_onnx
            ),
            transformer_model=os.path.basename(
                paths.encoder_path_fp16 if use_gpu else paths.encoder_path
            ),
            encoder_model_sha256=_sha256_file(
                paths.encoder_path_fp16 if use_gpu else paths.encoder_path
            ),
            decoder_model_sha256=_sha256_file(
                paths.decoder_path_fp16 if use_gpu else paths.decoder_path
            ),
        )
        connection.send(
            {"kind": "ready", "provenance": provenance.as_dict(), "warnings": warnings}
        )
    except Exception as error:  # pragma: no cover - startup failure path
        connection.send({"kind": "startup_failed", "detail": repr(error)[:2000]})
        return

    while True:
        try:
            request = connection.recv()
        except (EOFError, KeyboardInterrupt):
            return
        if request.get("kind") == "shutdown":
            return
        if request.get("kind") == "warmup_page":
            try:
                connection.send({"ok": True, "page": _warmup_page()})
            except Exception as error:
                connection.send(
                    {"ok": False, "code": CODE_FAILED, "detail": repr(error)[:2000]}
                )
            continue

        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix="ots-homr-") as directory:
                source = Path(directory) / f"page{request['suffix']}"
                source.write_bytes(request["page"])
                config = ProcessingConfig(
                    False,  # enable_debug
                    False,  # enable_cache
                    False,  # write_staff_positions
                    False,  # read_staff_positions
                    -1,  # selected_staff
                    use_gpu,  # transformer_use_gpu
                    use_gpu,  # segnet_use_gpu
                    False,  # coreml_encoder
                    bool(request["detect_title"]),
                )
                process_image(str(source), config, XmlGeneratorArguments())
                output = source.with_suffix(".musicxml")
                if not output.is_file():
                    raise InferenceError(CODE_FAILED, "HOMR produced no MusicXML")
                result = output.read_bytes()
            if b"<score-partwise" not in result and b"<score-timewise" not in result:
                raise InferenceError(CODE_FAILED, "HOMR produced invalid MusicXML")
            connection.send(
                {
                    "ok": True,
                    "musicxml": result,
                    "durationMs": int((time.monotonic() - started) * 1000),
                }
            )
        except InferenceError as error:
            connection.send({"ok": False, "code": error.code, "detail": error.detail})
        except Exception as error:
            connection.send(
                {
                    "ok": False,
                    "code": classify_homr_error(str(error)),
                    "detail": repr(error)[:2000],
                }
            )


class HomrEngine:
    """Supervises the warm inference child and serialises requests to it."""

    def __init__(
        self,
        *,
        use_gpu: bool,
        homr_commit: str,
        hard_timeout_seconds: int,
        startup_timeout_seconds: int = 600,
        expected_model_sha256: dict[str, str] | None = None,
    ) -> None:
        self._use_gpu = use_gpu
        self._homr_commit = homr_commit
        self._hard_timeout = hard_timeout_seconds
        self._startup_timeout = startup_timeout_seconds
        # Optional supply-chain pin (design section 9.5). Empty means unpinned.
        self._expected_model_sha256 = {
            key: value for key, value in (expected_model_sha256 or {}).items() if value
        }
        # `spawn` keeps the child free of any state the web process already holds.
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._process: Any = None
        self._connection: Any = None
        self._provenance = EngineProvenance(homr_commit=homr_commit)
        self._ready = False
        self._warm = False
        self._degraded_reason = ""
        self._last_error = ""
        self._startup_warnings: list[str] = []

    @property
    def expected_execution_provider(self) -> str:
        return "CUDAExecutionProvider" if self._use_gpu else "CPUExecutionProvider"

    @property
    def provenance(self) -> EngineProvenance:
        return self._provenance

    @property
    def degraded_reason(self) -> str:
        return "; ".join(
            part for part in (self._degraded_reason, *self._startup_warnings) if part
        )

    @property
    def last_error(self) -> str:
        return self._last_error

    def is_ready(self) -> bool:
        """Ready means: child alive, expected EP present, warm-up completed."""
        return bool(
            self._ready
            and self._warm
            and self._process is not None
            and self._process.is_alive()
        )

    def is_alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    def start(self) -> None:
        with self._lock:
            self._ensure_child_locked()

    def _ensure_child_locked(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        self._teardown_locked()
        parent_connection, child_connection = self._context.Pipe(duplex=True)
        process = self._context.Process(
            target=_child_main,
            args=(child_connection, self._use_gpu),
            daemon=True,
        )
        process.start()
        child_connection.close()
        self._process = process
        self._connection = parent_connection
        self._ready = False

        if not parent_connection.poll(self._startup_timeout):
            self._last_error = "The inference child did not start in time"
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")
        message = parent_connection.recv()
        if message.get("kind") != "ready":
            self._last_error = str(message.get("detail", "startup failed"))[:2000]
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")

        self._startup_warnings = list(message.get("warnings") or [])
        values = message["provenance"]
        self._provenance = EngineProvenance(
            homr_commit=self._homr_commit,
            execution_provider=self.expected_execution_provider,
            available_execution_providers=list(values["availableExecutionProviders"]),
            segmentation_model=values["segmentationModel"],
            segmentation_model_sha256=values["segmentationModelSha256"],
            transformer_model=values["transformerModel"],
            encoder_model_sha256=values["encoderModelSha256"],
            decoder_model_sha256=values["decoderModelSha256"],
        )
        # Fail closed: a GPU deployment must never quietly serve CPU inference.
        if self.expected_execution_provider not in self._provenance.available_execution_providers:
            self._last_error = f"{self.expected_execution_provider} is unavailable"
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, self._last_error)

        mismatch = self._model_pin_mismatch()
        if mismatch:
            self._last_error = mismatch
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, mismatch)
        self._ready = True

    def _model_pin_mismatch(self) -> str:
        actual = {
            "segmentation": self._provenance.segmentation_model_sha256,
            "encoder": self._provenance.encoder_model_sha256,
            "decoder": self._provenance.decoder_model_sha256,
        }
        for name, expected in self._expected_model_sha256.items():
            if name in actual and actual[name] != expected:
                return f"The {name} model does not match its pinned SHA-256"
        return ""

    def _teardown_locked(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except OSError:
                pass
            self._connection = None
        if self._process is not None:
            if self._process.is_alive():
                self._process.kill()
            self._process.join(timeout=10)
            self._process = None
        self._ready = False
        # A replacement child has cold sessions, so readiness must wait for a
        # fresh warm-up rather than inheriting the previous one.
        self._warm = False

    def restart(self) -> None:
        with self._lock:
            self._teardown_locked()
            self._ensure_child_locked()

    def shutdown(self) -> None:
        with self._lock:
            if self._connection is not None:
                try:
                    self._connection.send({"kind": "shutdown"})
                except (OSError, BrokenPipeError, ValueError):
                    pass
            self._teardown_locked()
            self._warm = False

    def warm_up(self) -> None:
        """Run one real inference so readiness implies a working pipeline.

        A synthetic staff exercises segmentation, staff detection, and the
        transformer. If it detects no staff the ONNX stack is still proven, so
        the provider reports ready but records a degraded reason for operators
        rather than refusing all traffic on a warm-up heuristic.
        """
        with self._lock:
            self._ensure_child_locked()
            page = self._request_locked({"kind": "warmup_page"}, timeout=120)
            try:
                self._request_locked(
                    {
                        "kind": "transcribe",
                        "page": page["page"],
                        "suffix": ".png",
                        "detect_title": False,
                    },
                    timeout=self._hard_timeout,
                )
                self._degraded_reason = ""
            except InferenceError as error:
                if error.code != CODE_NO_STAFF:
                    self._warm = False
                    raise
                self._degraded_reason = (
                    "Warm-up detected no staff on the synthetic page; models are "
                    "loaded but transformer decoding was not exercised"
                )
            self._warm = True

    def transcribe(self, page: bytes, suffix: str, detect_title: bool) -> dict[str, Any]:
        with self._lock:
            self._ensure_child_locked()
            return self._request_locked(
                {
                    "kind": "transcribe",
                    "page": page,
                    "suffix": suffix,
                    "detect_title": detect_title,
                },
                timeout=self._hard_timeout,
            )

    def _request_locked(self, request: dict[str, Any], timeout: int) -> dict[str, Any]:
        connection = self._connection
        if connection is None:
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")
        try:
            connection.send(request)
        except (OSError, BrokenPipeError, ValueError) as error:
            self._last_error = repr(error)[:2000]
            self._teardown_locked()
            raise InferenceError(CODE_FAILED, "The inference worker is unavailable") from error

        if not connection.poll(timeout):
            # Native work cannot be interrupted, so replace the whole child.
            self._last_error = f"Inference exceeded {timeout}s"
            self._teardown_locked()
            raise InferenceError(CODE_TIMEOUT, "HOMR exceeded the page time limit")
        try:
            response = connection.recv()
        except (EOFError, OSError) as error:
            self._last_error = repr(error)[:2000]
            self._teardown_locked()
            raise InferenceError(CODE_FAILED, "The inference worker stopped") from error

        if response.get("ok"):
            return response
        code = str(response.get("code") or CODE_FAILED)
        self._last_error = str(response.get("detail", ""))[:2000]
        raise InferenceError(code, _SAFE_MESSAGES.get(code, "HOMR could not process this page"))


_SAFE_MESSAGES = {
    CODE_NO_STAFF: "No staff lines were detected on this page",
    CODE_INVALID_IMAGE: "The page image could not be decoded",
    CODE_TIMEOUT: "HOMR exceeded the page time limit",
    CODE_FAILED: "HOMR could not process this page",
    CODE_NOT_READY: "The inference worker is not ready",
}
