"""Authenticated Modal GPU endpoint for the OurTextScores Scanner pilot.

The request handling, validation, idempotency, health, provenance, and error
taxonomy all come from the shared `homr_provider` factory, so this file only
describes the Modal deployment itself. Keeping one implementation is deliberate:
the previous split copy diverged and reported GPU-unavailable as an
unrecognisable page.
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

HOMR_COMMIT = "1ddc6fcc26c4baa746eaffbba7f5e01429063465"
SERVICE_REVISION = "ots-homr-modal-v1"
MAX_PAGE_BYTES = 25 * 1024 * 1024

# Timeout ladder (design section 9.3). The provider must give up before the
# caller does, or an abandoned page keeps billing GPU time after OTS has already
# classified the call as failed:
#
#   HARD_TIMEOUT_SECONDS  <  OTS SCANNER_PROVIDER_TIMEOUT_MS  <  FUNCTION_TIMEOUT
#            540                        600                            660
HARD_TIMEOUT_SECONDS = int(os.environ.get("HOMR_HARD_TIMEOUT_SECONDS", "540"))
FUNCTION_TIMEOUT_SECONDS = int(os.environ.get("HOMR_FUNCTION_TIMEOUT_SECONDS", "660"))

# Supply chain (design section 9.5). Pin the base by digest before the pilot;
# capture it with `docker buildx imagetools inspect` and set HOMR_CUDA_BASE.
# The tag below is the tested default, not a reproducible pin.
CUDA_BASE = os.environ.get(
    "HOMR_CUDA_BASE", "nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04"
)
# Set after the first build from /v1/capabilities so a silently changed weight
# file fails readiness instead of quietly altering results.
EXPECTED_MODEL_SHA256 = {
    key: value
    for key, value in (
        ("segmentation", os.environ.get("HOMR_EXPECTED_SEGMENTATION_SHA256", "")),
        ("encoder", os.environ.get("HOMR_EXPECTED_ENCODER_SHA256", "")),
        ("decoder", os.environ.get("HOMR_EXPECTED_DECODER_SHA256", "")),
    )
    if value
}

SHARED = Path(__file__).resolve().parent.parent / "homr-provider"

image = (
    modal.Image.from_registry(CUDA_BASE, add_python="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0", "libgomp1", "ca-certificates")
    .run_commands(
        "git clone https://github.com/liebharc/homr.git /opt/homr",
        f"cd /opt/homr && git checkout --detach {HOMR_COMMIT}",
        f"cd /opt/homr && test \"$(git rev-parse HEAD)\" = {HOMR_COMMIT}",
        "python -m pip install --no-cache-dir '/opt/homr[gpu]' 'fastapi[standard]' python-multipart",
        # Bake the weights in so readiness never waits on a download.
        "cd /opt/homr && homr --init --gpu force",
    )
    .env({"PYTHONUNBUFFERED": "1", "HOMR_COMMIT": HOMR_COMMIT})
    .add_local_dir(SHARED, remote_path="/opt/ots-homr-provider", copy=True)
    .env({"PYTHONPATH": "/opt/ots-homr-provider"})
)

app = modal.App("ourtextscores-homr-scanner")


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
def homr_api():
    import sys

    sys.path.insert(0, "/opt/ots-homr-provider")
    from homr_provider import create_provider_app

    return create_provider_app(
        use_gpu=True,
        homr_commit=HOMR_COMMIT,
        service_revision=SERVICE_REVISION,
        max_page_bytes=MAX_PAGE_BYTES,
        hard_timeout_seconds=HARD_TIMEOUT_SECONDS,
        # Modal proxy authentication fronts the app; no second shared secret.
        provider_token="",
        expected_model_sha256=EXPECTED_MODEL_SHA256,
    )
