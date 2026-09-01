"""HTTP contract for the private rareNum OTS-HOMR Scanner provider.

The Modal entrypoint supplies the pinned ONNX runtime.  Keeping this contract
separate makes its policy/provenance checks testable without a GPU.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
import uuid
from typing import Any, Protocol

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

SCHEMA_VERSION = "ots-ots-homr-provider.v1"
SUPPORTED_CONTENT_TYPES = {"image/png", "image/jpeg"}
TEXT_DETECTORS = {"lyrics", "non-lyric-text", "none"}
HEAD_MODES = {"off", "review-only", "experimental-output"}


class Engine(Protocol):
    def is_ready(self) -> bool: ...
    def warm_up(self) -> None: ...
    def transcribe(self, page: bytes, content_type: str, detect_title: bool, text_detector: str, head_mode: str) -> bytes: ...
    def identity(self, text_detector: str, head_mode: str) -> dict[str, Any]: ...


def _error(request_id: str, code: str, message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"schemaVersion": SCHEMA_VERSION, "requestId": request_id, "error": {"code": code, "message": message}})


def create_provider_app(*, engine: Engine, service_revision: str, provider_token: str = "", max_page_bytes: int = 25 * 1024 * 1024) -> FastAPI:
    app = FastAPI(title="OurTextScores OTS-HOMR provider", version=service_revision)

    def auth(value: str | None) -> None:
        if provider_token and (not value or not hmac.compare_digest(value, f"Bearer {provider_token}")):
            raise HTTPException(status_code=401, detail="Provider authentication is required")

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "schemaVersion": SCHEMA_VERSION, "serviceRevision": service_revision}

    @app.get("/readyz")
    async def readyz() -> Any:
        if not engine.is_ready():
            try:
                engine.warm_up()
            except Exception:
                pass
        body = {"ready": engine.is_ready(), "schemaVersion": SCHEMA_VERSION, "serviceRevision": service_revision}
        return body if body["ready"] else JSONResponse(status_code=503, content=body)

    @app.get("/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        return {"schemaVersion": SCHEMA_VERSION, "engine": "ots-homr", "serviceRevision": service_revision, "ready": engine.is_ready(), "textDetectors": sorted(TEXT_DETECTORS - {"none"}), "structuredHeadModes": sorted(HEAD_MODES), "allowedEmittedHeadFamilies": ["beam.level", "advance.delta"], **engine.identity("lyrics", "off")}

    @app.post("/v1/scan-page")
    async def scan_page(page: UploadFile = File(...), detectTitle: bool = Form(False), textDetector: str = Form("lyrics"), structuredHeadsMode: str = Form("off"), idempotency_key: str = Header(..., alias="Idempotency-Key"), authorization: str | None = Header(None, alias="Authorization")) -> Any:
        auth(authorization)
        request_id = uuid.uuid4().hex
        if len(idempotency_key) != 64 or any(c not in "0123456789abcdef" for c in idempotency_key):
            return _error(request_id, "invalid_option", "Invalid Idempotency-Key")
        if page.content_type not in SUPPORTED_CONTENT_TYPES:
            return _error(request_id, "invalid_media_type", "Only PNG and JPEG pages are supported", 415)
        if textDetector not in TEXT_DETECTORS or structuredHeadsMode not in HEAD_MODES:
            return _error(request_id, "invalid_option", "Invalid OTS-HOMR policy")
        content = await page.read(max_page_bytes + 1)
        if len(content) > max_page_bytes:
            return _error(request_id, "image_too_large", "Page exceeds the size limit", 413)
        if not engine.is_ready():
            return _error(request_id, "model_not_ready", "The inference worker is not ready", 503)
        started = time.monotonic()
        try:
            xml = engine.transcribe(content, page.content_type, detectTitle, textDetector, structuredHeadsMode)
        except Exception:
            return _error(request_id, "inference_failed", "OTS-HOMR could not process this page", 500)
        identity = engine.identity(textDetector, structuredHeadsMode)
        heads = identity.get("structuredHeads")
        if heads and "dynamic.mark" in heads.get("emittedHeadFamilies", []):
            return _error(request_id, "inference_failed", "Dynamic output is prohibited", 500)
        return {"schemaVersion": SCHEMA_VERSION, "requestId": request_id, "inputSha256": hashlib.sha256(content).hexdigest(), "engine": {"name": "ots-homr", "serviceRevision": service_revision, **identity}, "result": {"musicXmlBase64": base64.b64encode(xml).decode(), "musicXmlSha256": hashlib.sha256(xml).hexdigest()}, "timing": {"inferenceMs": int((time.monotonic() - started) * 1000)}}

    return app
