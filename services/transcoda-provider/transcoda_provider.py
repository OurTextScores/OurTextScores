"""Hardened HTTP contract shared by Transcoda deployments."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from transcoda_engine import (
    CODE_FAILED,
    CODE_GENERATION_FAILED,
    CODE_INVALID_IMAGE,
    CODE_NO_STAFF,
    CODE_NOT_READY,
    CODE_TIMEOUT,
    InferenceError,
    TranscodaEngine,
)

SCHEMA_VERSION = "ots-transcoda-provider.v1"
SUPPORTED_CONTENT_TYPES = {"image/jpeg", "image/png"}
PROVIDER_LICENSE = "AGPL-3.0-or-later"
TRANSCODA_LICENSE = "AGPL-3.0-only"
MODEL_LICENSE = "CC-BY-4.0"

_STATUS_BY_CODE = {
    "invalid_media_type": 415,
    "image_too_large": 413,
    CODE_INVALID_IMAGE: 422,
    CODE_NO_STAFF: 422,
    CODE_GENERATION_FAILED: 422,
    "invalid_option": 400,
    "busy": 429,
    CODE_NOT_READY: 503,
    CODE_TIMEOUT: 504,
    CODE_FAILED: 500,
}

logger = logging.getLogger("ots.transcoda.provider")


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
    return page.startswith(b"\xff\xd8\xff")


def create_provider_app(
    *,
    use_gpu: bool,
    checkpoint_path: str,
    model_artifact: str,
    model_revision: str,
    model_artifact_sha256: str,
    transcoda_commit: str,
    encoder_artifact: str,
    encoder_revision: str,
    encoder_artifact_sha256: str,
    encoder_path: str,
    service_revision: str,
    container_image_digest: str,
    converter: str,
    converter_version: str,
    max_page_bytes: int,
    hard_timeout_seconds: int,
    ready_wait_seconds: int = 120,
    warmup_page_path: str | None = None,
    source_commit: str = "main",
    provider_token: str = "",
    idempotency_cache_size: int = 16,
    engine_factory: Callable[[], TranscodaEngine] | None = None,
) -> FastAPI:
    """Create the provider app around a real or test engine."""
    if not re.fullmatch(r"[0-9a-f]{64}", model_artifact_sha256):
        raise ValueError("model_artifact_sha256 must be a lowercase SHA-256")
    if not re.fullmatch(r"[0-9a-f]{64}", encoder_artifact_sha256):
        raise ValueError("encoder_artifact_sha256 must be a lowercase SHA-256")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", container_image_digest):
        raise ValueError("container_image_digest must be a lowercase SHA-256 digest")
    if not all(
        value.strip()
        for value in (
            checkpoint_path,
            model_artifact,
            model_revision,
            transcoda_commit,
            encoder_artifact,
            encoder_revision,
            encoder_path,
            service_revision,
            converter_version,
        )
    ):
        raise ValueError("provider identity fields must not be empty")
    if converter != "music21":
        raise ValueError("The Transcoda provider supports only the music21 converter")

    warmup_page = warmup_page_path or str(Path(__file__).parent / "warmup-page.png")
    engine = (
        engine_factory
        or (
            lambda: TranscodaEngine(
                use_gpu=use_gpu,
                checkpoint_path=checkpoint_path,
                model_artifact=model_artifact,
                model_revision=model_revision,
                model_artifact_sha256=model_artifact_sha256,
                transcoda_commit=transcoda_commit,
                encoder_artifact=encoder_artifact,
                encoder_revision=encoder_revision,
                encoder_artifact_sha256=encoder_artifact_sha256,
                encoder_path=encoder_path,
                converter=converter,
                converter_version=converter_version,
                hard_timeout_seconds=hard_timeout_seconds,
                warmup_page_path=warmup_page,
            )
        )
    )()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.get_running_loop().create_task(ensure_warm())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.to_thread(engine.shutdown)

    app = FastAPI(
        title="OurTextScores Transcoda provider",
        version=service_revision,
        lifespan=lifespan,
    )
    app.state.engine = engine
    app.state.busy = False
    app.state.warming = False
    app.state.warm_attempts = 0
    app.state.warm_up_error = ""
    app.state.background: set[Any] = set()
    app.state.result_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
    cache_limit = max(1, idempotency_cache_size)

    def require_authorization(authorization: str | None) -> None:
        if not provider_token:
            return
        expected = f"Bearer {provider_token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(
                status_code=401, detail="Provider authentication is required"
            )

    def schedule_warm() -> None:
        task = asyncio.get_running_loop().create_task(ensure_warm())
        app.state.background.add(task)
        task.add_done_callback(app.state.background.discard)

    async def ensure_warm() -> None:
        if engine.is_ready() or app.state.warming:
            return
        app.state.warming = True
        try:
            await asyncio.to_thread(engine.warm_up)
            app.state.warm_up_error = ""
            logger.info("Transcoda provider warm-up complete")
        except InferenceError as error:
            app.state.warm_up_error = (
                f"{error.code}: {engine.last_error or error.message}"
            )
            logger.error(
                "Transcoda provider warm-up failed: %s", app.state.warm_up_error
            )
        except Exception as error:  # pragma: no cover - defensive
            app.state.warm_up_error = repr(error)[:2000]
            logger.exception("Transcoda provider warm-up failed")
        finally:
            app.state.warming = False
            app.state.warm_attempts += 1

    async def await_ready(deadline_seconds: int) -> bool:
        if engine.is_ready():
            return True
        attempts_before = app.state.warm_attempts
        schedule_warm()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0, deadline_seconds)
        while loop.time() < deadline:
            if engine.is_ready():
                return True
            if app.state.warm_attempts > attempts_before and not app.state.warming:
                return False
            await asyncio.sleep(0.5)
        return engine.is_ready()

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
            "modelRevision": model_revision,
        }

    @app.get("/readyz")
    async def readyz() -> Any:
        ready = engine.is_ready()
        body: dict[str, Any] = {
            "ready": ready,
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
            "modelRevision": model_revision,
            "executionProvider": engine.expected_execution_provider,
            "accelerator": engine.provenance.accelerator,
        }
        if not ready:
            body["reason"] = (
                app.state.warm_up_error or engine.last_error or "warming up"
            )
            schedule_warm()
            return JSONResponse(status_code=503, content=body)
        return body

    @app.get("/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        provenance = engine.provenance
        return {
            "schemaVersion": SCHEMA_VERSION,
            "engine": "transcoda",
            "serviceRevision": service_revision,
            "transcodaCommit": transcoda_commit,
            "modelArtifact": model_artifact,
            "modelRevision": model_revision,
            "modelArtifactSha256": model_artifact_sha256,
            "encoderArtifact": provenance.encoder_artifact or encoder_artifact,
            "encoderRevision": provenance.encoder_revision or encoder_revision,
            "encoderArtifactSha256": (
                provenance.encoder_artifact_sha256 or encoder_artifact_sha256
            ),
            "containerImageDigest": container_image_digest,
            "containerIdentityKind": "modal-build-manifest-sha256",
            "converter": provenance.converter or converter,
            "converterVersion": provenance.converter_version or converter_version,
            "executionProvider": engine.expected_execution_provider,
            "availableExecutionProviders": provenance.available_execution_providers,
            "accelerator": provenance.accelerator,
            "inputContentTypes": sorted(SUPPORTED_CONTENT_TYPES),
            "maxPageBytes": max_page_bytes,
            "hardTimeoutSeconds": hard_timeout_seconds,
            "decoding": {
                "strategy": "beam",
                "numBeams": 3,
                "maxLength": 2048,
                "repetitionPenalty": 1.1,
            },
            "source": f"https://github.com/OurTextScores/OurTextScores/tree/{source_commit}/services/transcoda-provider",
            "upstreamSource": f"https://github.com/btrkeks/transcoda/tree/{transcoda_commit}",
            "providerLicense": PROVIDER_LICENSE,
            "transcodaLicense": TRANSCODA_LICENSE,
            "modelLicense": MODEL_LICENSE,
        }

    @app.post("/v1/scan-page")
    async def scan_page(
        page: UploadFile = File(...),  # noqa: B008 - FastAPI dependency declaration
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
            return _error(
                request_id,
                "invalid_media_type",
                "Only PNG and JPEG pages are supported",
            )
        contents = await page.read(max_page_bytes + 1)
        if len(contents) > max_page_bytes:
            return _error(request_id, "image_too_large", "Page exceeds the size limit")
        if not _looks_like(page.content_type, contents):
            return _error(
                request_id, CODE_INVALID_IMAGE, "The page is not a valid PNG or JPEG"
            )

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
            return cached

        if not await await_ready(ready_wait_seconds):
            return _error(
                request_id, CODE_NOT_READY, "The inference worker is not ready"
            )
        if app.state.busy:
            return _error(request_id, "busy", "The provider is processing another page")
        app.state.busy = True
        try:
            result = await asyncio.to_thread(engine.transcribe, contents)
        except InferenceError as error:
            logger.warning(
                "requestId=%s code=%s detail=%s",
                request_id,
                error.code,
                engine.last_error,
            )
            return _error(request_id, error.code, error.message)
        except Exception:  # pragma: no cover - defensive
            logger.exception("requestId=%s unexpected provider failure", request_id)
            return _error(
                request_id, CODE_FAILED, "Transcoda could not process this page"
            )
        finally:
            app.state.busy = False

        kern = result["kern"]
        musicxml = result["musicxml"]
        provenance = engine.provenance
        response = {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "inputSha256": input_sha256,
            "engine": {
                "name": "transcoda",
                "serviceRevision": service_revision,
                "transcodaCommit": transcoda_commit,
                "modelArtifact": provenance.model_artifact,
                "modelRevision": provenance.model_revision,
                "modelArtifactSha256": provenance.model_artifact_sha256,
                "encoderArtifact": provenance.encoder_artifact,
                "encoderRevision": provenance.encoder_revision,
                "encoderArtifactSha256": provenance.encoder_artifact_sha256,
                "containerImageDigest": container_image_digest,
                "executionProvider": provenance.execution_provider,
                "converter": provenance.converter,
                "converterVersion": provenance.converter_version,
            },
            "result": {
                "kernBase64": base64.b64encode(kern).decode("ascii"),
                "kernSha256": hashlib.sha256(kern).hexdigest(),
                "musicXmlBase64": base64.b64encode(musicxml).decode("ascii"),
                "musicXmlSha256": hashlib.sha256(musicxml).hexdigest(),
                "generation": dict(result.get("generation") or {}),
            },
            "timing": {
                "totalMs": int((time.monotonic() - started) * 1000),
                "inferenceMs": int(result.get("durationMs", 0)),
            },
        }
        app.state.result_cache[idempotency_key] = response
        app.state.result_cache.move_to_end(idempotency_key)
        while len(app.state.result_cache) > cache_limit:
            app.state.result_cache.popitem(last=False)
        return response

    return app
