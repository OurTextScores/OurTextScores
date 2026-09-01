"""HTTP contract for the private rareNum OTS-HOMR Scanner provider.

The Modal entrypoint supplies the pinned ONNX runtime.  Keeping this contract
separate makes its policy/provenance checks testable without a GPU.
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
from typing import Any, Protocol

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from homr_review import prune_staves

SCHEMA_VERSION = "ots-ots-homr-provider.v1"
SUPPORTED_CONTENT_TYPES = {"image/png", "image/jpeg"}
TEXT_DETECTORS = {"lyrics", "non-lyric-text", "none"}
HEAD_MODES = {"off", "review-only", "experimental-output"}
ERROR_STATUS = {
    "invalid_media_type": 415,
    "image_too_large": 413,
    "invalid_image": 422,
    "no_staff_detected": 422,
    "generation_failed": 422,
    "invalid_option": 400,
    "model_not_ready": 503,
    "inference_timeout": 504,
    "inference_failed": 500,
}

logger = logging.getLogger(__name__)


class Engine(Protocol):
    def is_ready(self) -> bool: ...
    def warm_up(self) -> None: ...
    def transcribe(
        self,
        page: bytes,
        content_type: str,
        detect_title: bool,
        text_detector: str,
        head_mode: str,
    ) -> dict[str, Any]: ...
    def regenerate(self, staffs: list[list[list[str]]], title: str = "") -> bytes: ...
    def identity(self, text_detector: str, head_mode: str) -> dict[str, Any]: ...


def _matches_content_type(content: bytes, content_type: str) -> bool:
    if content_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    return False


def _error(
    request_id: str, code: str, message: str, status: int | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=status if status is not None else ERROR_STATUS.get(code, 500),
        content={
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "error": {"code": code, "message": message},
        },
    )


def create_provider_app(
    *,
    engine: Engine,
    service_revision: str,
    provider_source_commit: str = "",
    provider_token: str = "",
    max_page_bytes: int = 25 * 1024 * 1024,
) -> FastAPI:
    provider_source_commit = provider_source_commit.strip()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async def warm_engine() -> None:
            try:
                await asyncio.to_thread(engine.warm_up)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("OTS-HOMR background warm-up failed")

        task = asyncio.create_task(warm_engine())
        try:
            yield
        finally:
            task.cancel()
            shutdown = getattr(engine, "shutdown", None)
            if shutdown:
                await asyncio.to_thread(shutdown)

    app = FastAPI(
        title="OurTextScores OTS-HOMR provider",
        version=service_revision,
        lifespan=lifespan,
    )
    app.state.result_cache = OrderedDict()

    def auth(value: str | None) -> None:
        if provider_token and (
            not value or not hmac.compare_digest(value, f"Bearer {provider_token}")
        ):
            raise HTTPException(
                status_code=401, detail="Provider authentication is required"
            )

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
        }

    @app.get("/readyz")
    async def readyz() -> Any:
        if not engine.is_ready():
            try:
                await asyncio.to_thread(engine.warm_up)
            except Exception:
                logger.exception("OTS-HOMR readiness warm-up failed")
        body = {
            "ready": engine.is_ready(),
            "schemaVersion": SCHEMA_VERSION,
            "serviceRevision": service_revision,
        }
        return body if body["ready"] else JSONResponse(status_code=503, content=body)

    @app.get("/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        details = getattr(engine, "capabilities_identity", None)
        identity = details() if details else engine.identity("lyrics", "off")
        result = {
            "schemaVersion": SCHEMA_VERSION,
            "engine": "ots-homr",
            "serviceRevision": service_revision,
            "ready": engine.is_ready(),
            "textDetectorOptions": sorted(TEXT_DETECTORS),
            "structuredHeadModes": sorted(HEAD_MODES),
            "allowedEmittedHeadFamilies": ["beam.level", "advance.delta"],
            **identity,
        }
        if provider_source_commit:
            result.update(
                {
                    "providerSource": (
                        "https://github.com/OurTextScores/OurTextScores/tree/"
                        f"{provider_source_commit}/services/ots-homr-modal"
                    ),
                    "providerSourceCommit": provider_source_commit,
                    "providerLicense": "AGPL-3.0-or-later",
                    "homrSource": (
                        "https://github.com/OurTextScores/OurTextScores/blob/"
                        f"{provider_source_commit}/services/ots-homr-modal/source/"
                        "homr-997b70-source.tar.gz"
                    ),
                    "homrLicense": "AGPL-3.0",
                }
            )
        return result

    @app.post("/v1/scan-page")
    async def scan_page(
        page: UploadFile = File(...),
        detectTitle: bool = Form(False),
        textDetector: str = Form("lyrics"),
        structuredHeadsMode: str = Form("off"),
        idempotency_key: str = Header(..., alias="Idempotency-Key"),
        authorization: str | None = Header(None, alias="Authorization"),
    ) -> Any:
        auth(authorization)
        request_id = uuid.uuid4().hex
        if len(idempotency_key) != 64 or any(
            c not in "0123456789abcdef" for c in idempotency_key
        ):
            return _error(request_id, "invalid_option", "Invalid Idempotency-Key")
        if page.content_type not in SUPPORTED_CONTENT_TYPES:
            return _error(
                request_id,
                "invalid_media_type",
                "Only PNG and JPEG pages are supported",
                415,
            )
        if textDetector not in TEXT_DETECTORS or structuredHeadsMode not in HEAD_MODES:
            return _error(request_id, "invalid_option", "Invalid OTS-HOMR policy")
        content = await page.read(max_page_bytes + 1)
        if len(content) > max_page_bytes:
            return _error(
                request_id, "image_too_large", "Page exceeds the size limit", 413
            )
        if not _matches_content_type(content, page.content_type):
            return _error(
                request_id,
                "invalid_media_type",
                "Page bytes do not match the declared image type",
                415,
            )
        input_sha256 = hashlib.sha256(content).hexdigest()
        request_fingerprint = hashlib.sha256(
            b"\0".join(
                (
                    content,
                    str(detectTitle).lower().encode(),
                    textDetector.encode(),
                    structuredHeadsMode.encode(),
                )
            )
        ).hexdigest()
        cached = app.state.result_cache.get(idempotency_key)
        if cached is not None:
            if cached["requestFingerprint"] != request_fingerprint:
                return _error(
                    request_id,
                    "invalid_option",
                    "Idempotency-Key was already used for a different request",
                )
            app.state.result_cache.move_to_end(idempotency_key)
            return cached["response"]
        # A Modal container can accept its first request while lifespan warm-up
        # is still loading the graphs. Wait behind the engine's warm-up lock;
        # returning 503 immediately makes the caller spend every retry before a
        # cold container could possibly become ready.
        if not engine.is_ready():
            try:
                await asyncio.to_thread(engine.warm_up)
            except Exception:
                logger.exception("OTS-HOMR request warm-up failed")
        if not engine.is_ready():
            return _error(
                request_id, "model_not_ready", "The inference worker is not ready", 503
            )
        started = time.monotonic()
        try:
            result = await asyncio.to_thread(
                engine.transcribe,
                content,
                page.content_type,
                detectTitle,
                textDetector,
                structuredHeadsMode,
            )
            xml = result["musicxml"]
        except Exception as error:
            code = str(getattr(error, "code", "inference_failed"))
            if code not in ERROR_STATUS:
                code = "inference_failed"
            return _error(
                request_id,
                code,
                "OTS-HOMR could not process this page",
            )
        identity = engine.identity(textDetector, structuredHeadsMode)
        heads = identity.get("structuredHeads")
        if heads and "dynamic.mark" in heads.get("emittedHeadFamilies", []):
            return _error(
                request_id, "inference_failed", "Dynamic output is prohibited", 500
            )
        response = {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "inputSha256": input_sha256,
            "engine": {
                "name": "ots-homr",
                "serviceRevision": service_revision,
                **(
                    {"providerSourceCommit": provider_source_commit}
                    if provider_source_commit
                    else {}
                ),
                **identity,
            },
            "result": {
                "musicXmlBase64": base64.b64encode(xml).decode(),
                "musicXmlSha256": hashlib.sha256(xml).hexdigest(),
            },
            "review": {
                "staves": prune_staves(
                    ((result.get("review") or {}).get("staves") or [])
                )
            },
            "timing": {"inferenceMs": int((time.monotonic() - started) * 1000)},
        }
        app.state.result_cache[idempotency_key] = {
            "requestFingerprint": request_fingerprint,
            "response": response,
        }
        app.state.result_cache.move_to_end(idempotency_key)
        while len(app.state.result_cache) > 16:
            app.state.result_cache.popitem(last=False)
        return response

    @app.post("/v1/regenerate")
    async def regenerate(
        body: dict[str, Any],
        authorization: str | None = Header(None, alias="Authorization"),
    ) -> Any:
        auth(authorization)
        request_id = uuid.uuid4().hex
        staffs = body.get("staffs")
        if not isinstance(staffs, list) or not staffs:
            return _error(request_id, "invalid_option", "staffs is required")
        for staff in staffs:
            if not isinstance(staff, list):
                return _error(request_id, "invalid_option", "Each staff must be a list")
            for token in staff:
                if (
                    not isinstance(token, list)
                    or len(token) != 6
                    or not all(isinstance(field, str) for field in token)
                ):
                    return _error(
                        request_id,
                        "invalid_option",
                        "Each symbol must have six string fields",
                    )
        try:
            xml = await asyncio.to_thread(
                engine.regenerate, staffs, str(body.get("title", ""))
            )
        except Exception:
            logger.exception("OTS-HOMR review regeneration failed")
            return _error(
                request_id,
                "generation_failed",
                "The edited score could not be rebuilt",
            )
        return {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request_id,
            "result": {
                "musicXmlBase64": base64.b64encode(xml).decode(),
                "musicXmlSha256": hashlib.sha256(xml).hexdigest(),
            },
        }

    return app
