"""Authenticated Modal GPU endpoint for the OurTextScores Scanner pilot."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path

import modal

HOMR_COMMIT = "1ddc6fcc26c4baa746eaffbba7f5e01429063465"
SERVICE_REVISION = "ots-homr-modal-v1"
MAX_PAGE_BYTES = 25 * 1024 * 1024

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04",
        add_python="3.12",
    )
    .apt_install("git", "libgl1", "libglib2.0-0", "libgomp1", "ca-certificates")
    .run_commands(
        "git clone https://github.com/liebharc/homr.git /opt/homr",
        f"cd /opt/homr && git checkout --detach {HOMR_COMMIT}",
        "python -m pip install --no-cache-dir '/opt/homr[gpu]' 'fastapi[standard]' python-multipart",
        "cd /opt/homr && homr --init --gpu force",
    )
    .env({"PYTHONUNBUFFERED": "1"})
)

app = modal.App("ourtextscores-homr-scanner")


@app.function(
    image=image,
    gpu="L4",
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    timeout=900,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app(requires_proxy_auth=True)
def homr_api():
    import onnxruntime as ort
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

    web = FastAPI(title="OurTextScores HOMR Scanner", version=SERVICE_REVISION)
    result_cache: OrderedDict[str, dict[str, str]] = OrderedDict()
    cache_limit = 32

    def cuda_ready() -> bool:
        return "CUDAExecutionProvider" in ort.get_available_providers()

    def transcribe(page_bytes: bytes, suffix: str, detect_title: bool) -> bytes:
        if not cuda_ready():
            raise RuntimeError("CUDAExecutionProvider is unavailable")
        with tempfile.TemporaryDirectory(prefix="ots-homr-") as directory:
            source = Path(directory) / f"page{suffix}"
            source.write_bytes(page_bytes)
            command = ["homr", str(source), "--gpu", "force"]
            if not detect_title:
                command.append("--no-title")
            completed = subprocess.run(
                command,
                cwd="/opt/homr",
                capture_output=True,
                text=True,
                timeout=780,
                check=False,
            )
            if completed.returncode != 0:
                detail = completed.stderr.strip()[-2000:] or "HOMR failed"
                raise RuntimeError(detail)
            output = source.with_suffix(".musicxml")
            if not output.is_file():
                raise RuntimeError("HOMR did not produce MusicXML")
            result = output.read_bytes()
            if b"<score-partwise" not in result and b"<score-timewise" not in result:
                raise RuntimeError("HOMR produced invalid MusicXML")
            return result

    @web.get("/healthz")
    async def healthz():
        providers = ort.get_available_providers()
        if not cuda_ready():
            raise HTTPException(status_code=503, detail="CUDAExecutionProvider is unavailable")
        return {
            "ok": True,
            "serviceRevision": SERVICE_REVISION,
            "homrRevision": HOMR_COMMIT,
            "executionProviders": providers,
        }

    @web.get("/v1/capabilities")
    async def capabilities():
        return {
            "engine": "homr",
            "serviceRevision": SERVICE_REVISION,
            "homrRevision": HOMR_COMMIT,
            "inputContentTypes": ["image/png", "image/jpeg"],
            "maxPageBytes": MAX_PAGE_BYTES,
            "titleDetection": True,
        }

    @web.post("/v1/scan-page")
    async def scan_page(
        page: UploadFile = File(...),
        detectTitle: bool = Form(False),
        idempotency_key: str = Header(..., alias="Idempotency-Key"),
    ):
        if len(idempotency_key) != 64 or any(char not in "0123456789abcdef" for char in idempotency_key):
            raise HTTPException(status_code=400, detail="Invalid Idempotency-Key")
        if page.content_type not in {"image/png", "image/jpeg"}:
            raise HTTPException(status_code=415, detail="Only PNG and JPEG pages are supported")
        cached = result_cache.get(idempotency_key)
        if cached is not None:
            result_cache.move_to_end(idempotency_key)
            return cached

        contents = await page.read(MAX_PAGE_BYTES + 1)
        if len(contents) > MAX_PAGE_BYTES:
            raise HTTPException(status_code=413, detail="Page exceeds size limit")
        expected_digest = hashlib.sha256(contents).hexdigest()
        suffix = ".png" if page.content_type == "image/png" else ".jpg"
        try:
            music_xml = await asyncio.to_thread(transcribe, contents, suffix, detectTitle)
        except subprocess.TimeoutExpired as error:
            raise HTTPException(status_code=504, detail="HOMR timed out") from error
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)[:2000]) from error

        response = {
            "engine": "homr",
            "serviceRevision": SERVICE_REVISION,
            "homrRevision": HOMR_COMMIT,
            "modelRevision": HOMR_COMMIT,
            "executionProvider": "CUDAExecutionProvider",
            "inputSha256": expected_digest,
            "musicXmlBase64": base64.b64encode(music_xml).decode("ascii"),
        }
        result_cache[idempotency_key] = response
        result_cache.move_to_end(idempotency_key)
        while len(result_cache) > cache_limit:
            result_cache.popitem(last=False)
        return response

    return web
