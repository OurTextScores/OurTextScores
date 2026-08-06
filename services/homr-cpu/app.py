"""Local CPU-only HOMR provider for OurTextScores development and benchmarks."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path

import onnxruntime as ort
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

HOMR_COMMIT = os.environ.get(
    "HOMR_COMMIT", "1ddc6fcc26c4baa746eaffbba7f5e01429063465"
)
SERVICE_REVISION = os.environ.get("HOMR_SERVICE_REVISION", "ots-homr-cpu-v1")
SOURCE_URL = f"https://github.com/liebharc/homr/tree/{HOMR_COMMIT}"
MAX_PAGE_BYTES = int(os.environ.get("HOMR_MAX_PAGE_BYTES", str(25 * 1024 * 1024)))
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("HOMR_PROCESS_TIMEOUT_SECONDS", "1800"))
PROVIDER_TOKEN = os.environ.get("HOMR_PROVIDER_TOKEN", "")
CACHE_LIMIT = max(1, int(os.environ.get("HOMR_IDEMPOTENCY_CACHE_SIZE", "16")))

app = FastAPI(title="OurTextScores HOMR CPU Provider", version=SERVICE_REVISION)
inference_busy = False
result_cache: OrderedDict[str, dict[str, str]] = OrderedDict()


def cpu_ready() -> bool:
    return "CPUExecutionProvider" in ort.get_available_providers()


def require_authorization(authorization: str | None) -> None:
    if not PROVIDER_TOKEN:
        return
    expected = f"Bearer {PROVIDER_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Provider authentication is required")


def transcribe(page_bytes: bytes, suffix: str, detect_title: bool) -> bytes:
    if not cpu_ready():
        raise RuntimeError("CPUExecutionProvider is unavailable")
    with tempfile.TemporaryDirectory(prefix="ots-homr-cpu-") as directory:
        source = Path(directory) / f"page{suffix}"
        source.write_bytes(page_bytes)
        command = ["homr", str(source), "--gpu", "no"]
        if not detect_title:
            command.append("--no-title")
        completed = subprocess.run(
            command,
            cwd="/opt/homr",
            capture_output=True,
            text=True,
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0:
            raise ValueError("HOMR could not recognize this page")
        output = source.with_suffix(".musicxml")
        if not output.is_file():
            raise ValueError("HOMR did not produce MusicXML")
        result = output.read_bytes()
        if b"<score-partwise" not in result and b"<score-timewise" not in result:
            raise ValueError("HOMR produced invalid MusicXML")
        return result


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    providers = ort.get_available_providers()
    if not cpu_ready():
        raise HTTPException(status_code=503, detail="CPUExecutionProvider is unavailable")
    return {
        "ok": True,
        "serviceRevision": SERVICE_REVISION,
        "homrRevision": HOMR_COMMIT,
        "executionProviders": providers,
    }


@app.get("/v1/capabilities")
async def capabilities() -> dict[str, object]:
    return {
        "engine": "homr",
        "serviceRevision": SERVICE_REVISION,
        "homrRevision": HOMR_COMMIT,
        "executionProvider": "CPUExecutionProvider",
        "inputContentTypes": ["image/png", "image/jpeg"],
        "maxPageBytes": MAX_PAGE_BYTES,
        "titleDetection": True,
        "source": SOURCE_URL,
        "providerLicense": "AGPL-3.0-or-later",
        "homrLicense": "AGPL-3.0",
    }


@app.post("/v1/scan-page")
async def scan_page(
    page: UploadFile = File(...),
    detectTitle: bool = Form(False),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    authorization: str | None = Header(None, alias="Authorization"),
) -> dict[str, str]:
    global inference_busy

    require_authorization(authorization)
    if len(idempotency_key) != 64 or any(
        character not in "0123456789abcdef" for character in idempotency_key
    ):
        raise HTTPException(status_code=400, detail="Invalid Idempotency-Key")
    if page.content_type not in {"image/png", "image/jpeg"}:
        raise HTTPException(status_code=415, detail="Only PNG and JPEG pages are supported")
    contents = await page.read(MAX_PAGE_BYTES + 1)
    if len(contents) > MAX_PAGE_BYTES:
        raise HTTPException(status_code=413, detail="Page exceeds size limit")
    input_sha256 = hashlib.sha256(contents).hexdigest()
    cached = result_cache.get(idempotency_key)
    if cached is not None:
        if cached["inputSha256"] != input_sha256:
            raise HTTPException(
                status_code=409,
                detail="Idempotency-Key was already used for different input",
            )
        result_cache.move_to_end(idempotency_key)
        return cached
    # Check and set without awaiting so admission is atomic on this event loop.
    if inference_busy:
        raise HTTPException(status_code=429, detail="The CPU provider is busy")
    inference_busy = True

    suffix = ".png" if page.content_type == "image/png" else ".jpg"
    try:
        music_xml = await asyncio.to_thread(transcribe, contents, suffix, detectTitle)
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="HOMR timed out") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail="HOMR inference failed") from error
    finally:
        inference_busy = False

    response = {
        "engine": "homr",
        "serviceRevision": SERVICE_REVISION,
        "homrRevision": HOMR_COMMIT,
        "modelRevision": HOMR_COMMIT,
        "executionProvider": "CPUExecutionProvider",
        "inputSha256": input_sha256,
        "musicXmlBase64": base64.b64encode(music_xml).decode("ascii"),
    }
    result_cache[idempotency_key] = response
    result_cache.move_to_end(idempotency_key)
    while len(result_cache) > CACHE_LIMIT:
        result_cache.popitem(last=False)
    return response
