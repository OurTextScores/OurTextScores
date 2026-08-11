"""Pinned Modal GPU deployment for the Scanner's Transcoda engine."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

import modal

TRANSCODA_COMMIT = "82041ceec62352a040d068e1a279688cf13bb237"
MODEL_ARTIFACT = "btrkeks/transcoda-59M-zeroshot-v1"
MODEL_REVISION = "b529f8aa5d996d9224df3395b5b92d0867343c91"
MODEL_FILENAME = "transcoda-59M-zeroshot-v1.ckpt"
MODEL_ARTIFACT_SHA256 = (
    "3ce7387b94776cd0edc4e5b70fbc2e28ac0f4c812d5f978d1ef26e236dccdafc"
)
MODEL_URL = (
    f"https://huggingface.co/{MODEL_ARTIFACT}/resolve/{MODEL_REVISION}/{MODEL_FILENAME}"
)
ENCODER_ARTIFACT = "facebook/convnextv2-tiny-22k-224"
ENCODER_REVISION = "9cba4896e97bb86b1eb609e482a2149d84f345bc"
ENCODER_FILENAME = "model.safetensors"
ENCODER_ARTIFACT_SHA256 = (
    "b33653bb8c060f6dee6438f18c559dcf3258bf86cc906490daaca89bc0c39fb7"
)
ENCODER_PATH = "/opt/transcoda-encoder"
SERVICE_REVISION = "ots-transcoda-modal-v1"
CONVERTER = "music21"
CONVERTER_VERSION = "9.9.1"
MAX_PAGE_BYTES = 25 * 1024 * 1024

# A cold request may wait for warm-up and then spend the hard inference limit.
# Keep their sum under the backend's 600-second call limit, and that call limit
# under Modal's function timeout.
READY_WAIT_SECONDS = int(os.environ.get("TRANSCODA_READY_WAIT_SECONDS", "120"))
HARD_TIMEOUT_SECONDS = int(os.environ.get("TRANSCODA_HARD_TIMEOUT_SECONDS", "450"))
FUNCTION_TIMEOUT_SECONDS = int(
    os.environ.get("TRANSCODA_FUNCTION_TIMEOUT_SECONDS", "660")
)

CUDA_BASE_TAG = "nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04"
CUDA_BASE_DIGEST = (
    "sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb"
)
CUDA_BASE = os.environ.get(
    "TRANSCODA_CUDA_BASE", f"{CUDA_BASE_TAG.split(':')[0]}@{CUDA_BASE_DIGEST}"
)
UV_VERSION = "0.11.18"

HERE = Path(__file__).resolve().parent
SHARED = HERE.parent / "transcoda-provider"
WARMUP_PAGE = HERE.parent / "homr-provider" / "warmup-page.png"


def _source_commit() -> str:
    override = os.environ.get("OTS_SOURCE_COMMIT", "").strip()
    if override:
        return override
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(HERE),
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "main"


SOURCE_COMMIT = _source_commit()


def _build_manifest_digest() -> str:
    """Identify all inputs Modal uses to construct this immutable image.

    Modal images do not expose an OCI registry digest to the running function.
    This SHA-256 covers the pinned base, upstream/model revisions, lock-bearing
    upstream commit, OTS revision, and the exact local provider/deploy sources.
    Capabilities names the identity kind explicitly so it is not mistaken for a
    registry manifest digest.
    """
    digest = hashlib.sha256()
    for value in (
        CUDA_BASE_DIGEST,
        TRANSCODA_COMMIT,
        MODEL_ARTIFACT,
        MODEL_REVISION,
        MODEL_ARTIFACT_SHA256,
        ENCODER_ARTIFACT,
        ENCODER_REVISION,
        ENCODER_ARTIFACT_SHA256,
        SERVICE_REVISION,
        CONVERTER_VERSION,
        UV_VERSION,
        SOURCE_COMMIT,
    ):
        digest.update(value.encode("utf-8") + b"\0")
    shared_inputs = [
        path
        for path in SHARED.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
        and not path.name.startswith("test_")
    ]
    for path in sorted([Path(__file__), WARMUP_PAGE, *shared_inputs]):
        digest.update(path.name.encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
    return "sha256:" + digest.hexdigest()


def _resolve_container_image_digest() -> str:
    """Use the deploy-time digest when Modal re-imports this module remotely."""
    baked_digest = os.environ.get("TRANSCODA_CONTAINER_IMAGE_DIGEST", "").strip()
    if baked_digest:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", baked_digest):
            raise RuntimeError("The baked container manifest digest is invalid")
        return baked_digest
    return _build_manifest_digest()


CONTAINER_IMAGE_DIGEST = _resolve_container_image_digest()

image = (
    modal.Image.from_registry(CUDA_BASE, add_python="3.12")
    .apt_install("ca-certificates", "curl", "git", "libgomp1")
    .run_commands(
        f"python -m pip install --no-cache-dir 'uv=={UV_VERSION}'",
        "git clone https://github.com/btrkeks/transcoda.git /opt/transcoda",
        f"cd /opt/transcoda && git checkout --detach {TRANSCODA_COMMIT}",
        f'cd /opt/transcoda && test "$(git rev-parse HEAD)" = {TRANSCODA_COMMIT}',
        # Export from the upstream lock and retain every artifact hash. The OMR
        # conversion group supplies music21; training-only dev tools are omitted.
        "cd /opt/transcoda && uv export --frozen --no-dev --group omr-ned "
        "--no-emit-project --format requirements-txt -o /tmp/transcoda-requirements.txt",
        "uv pip install --system --require-hashes -r /tmp/transcoda-requirements.txt",
        "python -m pip install --no-cache-dir "
        "'fastapi==0.116.1' 'httpx==0.28.1' 'python-multipart==0.0.30'",
        # Transcoda constructs its ConvNeXt encoder with `from_pretrained`
        # before the checkpoint overwrites those weights. Bake that bootstrap
        # snapshot and force offline runtime loading so cold starts never follow
        # the mutable Hugging Face `main` branch.
        'python -c "from huggingface_hub import snapshot_download; '
        f"snapshot_download(repo_id='{ENCODER_ARTIFACT}', revision='{ENCODER_REVISION}', "
        f"local_dir='{ENCODER_PATH}', allow_patterns=['config.json', '{ENCODER_FILENAME}'])\"",
        f"echo '{ENCODER_ARTIFACT_SHA256}  {ENCODER_PATH}/{ENCODER_FILENAME}' "
        "| sha256sum --check --strict",
        f"curl --fail --location --retry 3 '{MODEL_URL}' --output /opt/transcoda/{MODEL_FILENAME}",
        f"echo '{MODEL_ARTIFACT_SHA256}  /opt/transcoda/{MODEL_FILENAME}' | sha256sum --check --strict",
        "rm -f /tmp/transcoda-requirements.txt",
    )
    .env(
        {
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": "/opt/ots-transcoda-provider:/opt/transcoda",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            # The checkpoint's run artifact resolves its tokenizer relative to
            # the upstream repository root.
            "TRANSCODA_PROJECT_ROOT": "/opt/transcoda",
            "TRANSCODA_HARD_TIMEOUT_SECONDS": str(HARD_TIMEOUT_SECONDS),
            "TRANSCODA_READY_WAIT_SECONDS": str(READY_WAIT_SECONDS),
            "OTS_SOURCE_COMMIT": SOURCE_COMMIT,
            "TRANSCODA_CONTAINER_IMAGE_DIGEST": CONTAINER_IMAGE_DIGEST,
        }
    )
    .add_local_dir(
        SHARED,
        remote_path="/opt/ots-transcoda-provider",
        copy=True,
        ignore=["__pycache__", "*.pyc", "test_*.py"],
    )
    .add_local_file(
        WARMUP_PAGE,
        remote_path="/opt/ots-transcoda-provider/warmup-page.png",
        copy=True,
    )
)

app = modal.App("ourtextscores-transcoda-scanner")


@app.function(
    image=image,
    gpu="L4",
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    timeout=FUNCTION_TIMEOUT_SECONDS,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app(requires_proxy_auth=True)
def transcoda_api():
    import sys

    os.chdir("/opt/transcoda")
    sys.path.insert(0, "/opt/ots-transcoda-provider")
    sys.path.insert(0, "/opt/transcoda")
    from transcoda_provider import create_provider_app

    return create_provider_app(
        use_gpu=True,
        checkpoint_path=f"/opt/transcoda/{MODEL_FILENAME}",
        model_artifact=MODEL_ARTIFACT,
        model_revision=MODEL_REVISION,
        model_artifact_sha256=MODEL_ARTIFACT_SHA256,
        transcoda_commit=TRANSCODA_COMMIT,
        encoder_artifact=ENCODER_ARTIFACT,
        encoder_revision=ENCODER_REVISION,
        encoder_artifact_sha256=ENCODER_ARTIFACT_SHA256,
        encoder_path=ENCODER_PATH,
        service_revision=SERVICE_REVISION,
        container_image_digest=CONTAINER_IMAGE_DIGEST,
        converter=CONVERTER,
        converter_version=CONVERTER_VERSION,
        max_page_bytes=MAX_PAGE_BYTES,
        hard_timeout_seconds=HARD_TIMEOUT_SECONDS,
        ready_wait_seconds=READY_WAIT_SECONDS,
        warmup_page_path="/opt/ots-transcoda-provider/warmup-page.png",
        source_commit=SOURCE_COMMIT,
        # Modal proxy authentication fronts the app.
        provider_token="",
    )
