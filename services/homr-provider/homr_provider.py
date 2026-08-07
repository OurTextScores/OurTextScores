"""Shared, hardened HOMR page-inference API for the OurTextScores Scanner.

Design reference: SCANNER_PAGE_HOMR_DESIGN_2026-08-06.md sections 9.1 to 9.4.

Both the Modal GPU provider and the local CPU provider build their app from
this factory so the authentication, validation, idempotency, health, and error
taxonomy stay identical. Divergence between the two is what previously let the
GPU provider report infrastructure failures as unrecognisable pages.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from homr_engine import (
    CODE_FAILED,
    CODE_INVALID_IMAGE,
    CODE_NO_STAFF,
    CODE_NOT_READY,
    CODE_TIMEOUT,
    HomrEngine,
    InferenceError,
)

SCHEMA_VERSION = "ots-homr-provider.v1"
MUSICXML_MEDIA_TYPE = "application/vnd.recordare.musicxml+xml"
SUPPORTED_CONTENT_TYPES = {"image/png", "image/jpeg"}
LICENSE = "AGPL-3.0-or-later"

# Design section 9.4. `inference_failed` is deliberately 500 (retryable-ish) and
# not 422: a 4xx tells OTS the page itself is at fault and must not be retried.
_STATUS_BY_CODE = {
    "invalid_media_type": 415,
    "image_too_large": 413,
    CODE_INVALID_IMAGE: 422,
    CODE_NO_STAFF: 422,
    "invalid_option": 400,
    "busy": 429,
    CODE_NOT_READY: 503,
    CODE_TIMEOUT: 504,
    CODE_FAILED: 500,
}

logger = logging.getLogger("ots.homr.provider")


def _error(request_id: str, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=_STATUS_BY_CODE.get(code, 500),
        content={
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "error": {"code": code, "message": message},
        },
    )


def _looks_like(content_type: str, page: bytes) -> bool:
    if content_type == "image/png":
        return page.startswith(b"\x89PNG\r\n\x1a\n")
    return page[:3] == b"\xff\xd8\xff"


def create_provider_app(
    *,
    use_gpu: bool,
    homr_commit: str,
    service_revision: str,
    max_page_bytes: int,
    hard_timeout_seconds: int,
    provider_token: str = "",
    idempotency_cache_size: int = 16,
    expected_model_sha256: dict[str, str] | None = None,
    engine_factory: Callable[[], HomrEngine] | None = None,
) -> FastAPI:
    engine = (engine_factory or _default_engine_factory(
        use_gpu=use_gpu,
        homr_commit=homr_commit,
        hard_timeout_seconds=hard_timeout_seconds,
        expected_model_sha256=expected_model_sha256,
    ))()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Warm up in the background so /healthz answers immediately; readiness
        # stays false until the smoke inference has actually completed.
        task = asyncio.get_running_loop().create_task(ensure_warm())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.to_thread(engine.shutdown)

    app = FastAPI(
        title="OurTextScores HOMR provider",
        version=service_revision,
        lifespan=lifespan,
    )
    app.state.engine = engine
    app.state.busy = False
    app.state.warming = False
    app.state.warm_up_error = ""
    # Successful results only. A transient failure must never poison a key.
    app.state.result_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
    cache_limit = max(1, idempotency_cache_size)

    def source_url() -> str:
        return f"https://github.com/liebharc/homr/tree/{homr_commit}"

    def require_authorization(authorization: str | None) -> None:
        if not provider_token:
            return
        expected = f"Bearer {provider_token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Provider authentication is required")

    async def ensure_warm() -> None:
        """Re-warm after a timeout kill so one bad page cannot wedge the service.

        The supervisor replaces a killed child, but the replacement has cold
        sessions and `is_ready()` stays false until a warm-up succeeds. Without
        this, the first hard timeout would leave the provider returning 503
        until an operator restarted it.
        """
        if engine.is_ready() or app.state.warming:
            return
        app.state.warming = True
        try:
            await warm_up()
        finally:
            app.state.warming = False

    async def warm_up() -> None:
        """Start the child and run one inference before reporting readiness."""
        try:
            await asyncio.to_thread(engine.warm_up)
            app.state.warm_up_error = ""
            if engine.degraded_reason:
                logger.warning("HOMR provider warm-up degraded: %s", engine.degraded_reason)
            else:
                logger.info("HOMR provider warm-up complete")
        except InferenceError as error:
            app.state.warm_up_error = f"{error.code}: {engine.last_error or error.message}"
            logger.error("HOMR provider warm-up failed: %s", app.state.warm_up_error)
        except Exception as error:  # pragma: no cover - defensive
            app.state.warm_up_error = repr(error)[:2000]
            logger.error("HOMR provider warm-up failed: %s", app.state.warm_up_error)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        """Liveness only: the HTTP process is running (design section 9.2)."""
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
            "homrRevision": homr_commit,
        }

    @app.get("/readyz")
    async def readyz() -> Any:
        provenance = engine.provenance
        ready = engine.is_ready()
        body: dict[str, Any] = {
            "ready": ready,
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
            "homrRevision": homr_commit,
            "executionProvider": engine.expected_execution_provider,
            "availableExecutionProviders": provenance.available_execution_providers,
            "degradedReason": engine.degraded_reason,
        }
        if not ready:
            body["reason"] = app.state.warm_up_error or engine.last_error or "warming up"
            # A polling health check doubles as the recovery trigger.
            asyncio.get_running_loop().create_task(ensure_warm())
            return JSONResponse(status_code=503, content=body)
        return body

    @app.get("/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        provenance = engine.provenance
        return {
            "schemaVersion": SCHEMA_VERSION,
            "engine": "homr",
            "serviceRevision": service_revision,
            "homrRevision": homr_commit,
            "inputContentTypes": sorted(SUPPORTED_CONTENT_TYPES),
            "maxPageBytes": max_page_bytes,
            "hardTimeoutSeconds": hard_timeout_seconds,
            "titleDetection": True,
            "ready": engine.is_ready(),
            **provenance.as_dict(),
            # AGPL section 12.6: network users must be able to reach the
            # corresponding source of the exact deployed service.
            "source": source_url(),
            "providerSource": "https://github.com/OurTextScores/OurTextScores/tree/main/services",
            "providerLicense": LICENSE,
            "homrLicense": "AGPL-3.0",
        }

    @app.post("/v1/scan-page")
    async def scan_page(
        page: UploadFile = File(...),
        detectTitle: bool = Form(False),
        idempotency_key: str = Header(..., alias="Idempotency-Key"),
        authorization: str | None = Header(None, alias="Authorization"),
    ) -> Any:
        require_authorization(authorization)
        request_id = uuid.uuid4().hex
        started = time.monotonic()

        if len(idempotency_key) != 64 or any(
            character not in "0123456789abcdef" for character in idempotency_key
        ):
            return _error(request_id, "invalid_option", "Invalid Idempotency-Key")
        if page.content_type not in SUPPORTED_CONTENT_TYPES:
            return _error(request_id, "invalid_media_type", "Only PNG and JPEG pages are supported")

        contents = await page.read(max_page_bytes + 1)
        if len(contents) > max_page_bytes:
            return _error(request_id, "image_too_large", "Page exceeds the size limit")
        if not _looks_like(page.content_type, contents):
            return _error(request_id, CODE_INVALID_IMAGE, "The page is not a valid PNG or JPEG")

        input_sha256 = hashlib.sha256(contents).hexdigest()
        cached = app.state.result_cache.get(idempotency_key)
        if cached is not None:
            if cached["inputSha256"] != input_sha256:
                return _error(
                    request_id,
                    "invalid_option",
                    "Idempotency-Key was already used for different input",
                )
            app.state.result_cache.move_to_end(idempotency_key)
            logger.info("requestId=%s idempotent replay", request_id)
            return cached

        if not engine.is_ready():
            # 503 is retryable for OTS, and this recovers the child in the
            # background so the retry has somewhere to land.
            asyncio.get_running_loop().create_task(ensure_warm())
            return _error(request_id, CODE_NOT_READY, "The inference worker is not ready")
        # Checked and set without an await so admission stays atomic here.
        if app.state.busy:
            return _error(request_id, "busy", "The provider is processing another page")
        app.state.busy = True

        suffix = ".png" if page.content_type == "image/png" else ".jpg"
        try:
            result = await asyncio.to_thread(engine.transcribe, contents, suffix, detectTitle)
        except InferenceError as error:
            # The detail may carry HOMR stack traces and local paths, so it is
            # logged under the request ID and never returned (design 9.4).
            logger.warning(
                "requestId=%s code=%s detail=%s", request_id, error.code, engine.last_error
            )
            return _error(request_id, error.code, error.message)
        except Exception as error:  # pragma: no cover - defensive
            logger.exception("requestId=%s unexpected provider failure", request_id)
            return _error(request_id, CODE_FAILED, "HOMR could not process this page")
        finally:
            app.state.busy = False

        music_xml = result["musicxml"]
        provenance = engine.provenance
        response = {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "engine": {
                "name": "homr",
                "homrCommit": homr_commit,
                "serviceRevision": service_revision,
                "segmentationModel": provenance.segmentation_model,
                "segmentationModelSha256": provenance.segmentation_model_sha256,
                "transformerModel": provenance.transformer_model,
                "encoderModelSha256": provenance.encoder_model_sha256,
                "decoderModelSha256": provenance.decoder_model_sha256,
                "executionProvider": provenance.execution_provider,
            },
            "result": {
                "mediaType": MUSICXML_MEDIA_TYPE,
                "musicXmlBase64": base64.b64encode(music_xml).decode("ascii"),
                "sha256": hashlib.sha256(music_xml).hexdigest(),
            },
            "timing": {
                "totalMs": int((time.monotonic() - started) * 1000),
                "inferenceMs": int(result.get("durationMs", 0)),
            },
            "warnings": (
                [{"code": "warmup_degraded", "message": engine.degraded_reason}]
                if engine.degraded_reason
                else []
            ),
            # Flat aliases retained so a backend deployed before this contract
            # change keeps working through a rolling restart.
            "serviceRevision": service_revision,
            "homrRevision": homr_commit,
            "modelRevision": homr_commit,
            "executionProvider": provenance.execution_provider,
            "inputSha256": input_sha256,
            "musicXmlBase64": base64.b64encode(music_xml).decode("ascii"),
        }
        logger.info(
            "requestId=%s ok bytes=%s totalMs=%s",
            request_id,
            len(music_xml),
            response["timing"]["totalMs"],
        )
        app.state.result_cache[idempotency_key] = response
        app.state.result_cache.move_to_end(idempotency_key)
        while len(app.state.result_cache) > cache_limit:
            app.state.result_cache.popitem(last=False)
        return response

    return app


def _default_engine_factory(
    *,
    use_gpu: bool,
    homr_commit: str,
    hard_timeout_seconds: int,
    expected_model_sha256: dict[str, str] | None = None,
) -> Callable[[], HomrEngine]:
    def build() -> HomrEngine:
        return HomrEngine(
            use_gpu=use_gpu,
            homr_commit=homr_commit,
            hard_timeout_seconds=hard_timeout_seconds,
            expected_model_sha256=expected_model_sha256,
        )

    return build
