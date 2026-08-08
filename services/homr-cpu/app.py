"""Local CPU-only HOMR provider for OurTextScores development and benchmarks.

Everything except the execution provider and the defaults below is shared with
the Modal GPU provider through `homr_provider.create_provider_app`.
"""

from __future__ import annotations

import os

from homr_provider import create_provider_app

HOMR_COMMIT = os.environ.get("HOMR_COMMIT", "1ddc6fcc26c4baa746eaffbba7f5e01429063465")
SERVICE_REVISION = os.environ.get("HOMR_SERVICE_REVISION", "ots-homr-cpu-v1")
MAX_PAGE_BYTES = int(os.environ.get("HOMR_MAX_PAGE_BYTES", str(25 * 1024 * 1024)))
# READY_WAIT + PROCESS_TIMEOUT must stay below the caller's
# SCANNER_PROVIDER_TIMEOUT_MS so the provider gives up first and never leaves an
# orphaned run burning CPU (design section 9.3). Locally that caller timeout is
# 1,860 s, set in docker-compose.scanner-local.yml.
READY_WAIT_SECONDS = int(os.environ.get("HOMR_READY_WAIT_SECONDS", "300"))
PROCESS_TIMEOUT_SECONDS = int(os.environ.get("HOMR_PROCESS_TIMEOUT_SECONDS", "1500"))
PROVIDER_TOKEN = os.environ.get("HOMR_PROVIDER_TOKEN", "")
CACHE_LIMIT = max(1, int(os.environ.get("HOMR_IDEMPOTENCY_CACHE_SIZE", "16")))
# Parity with Modal: pin the weights that were actually loaded, read from
# /v1/capabilities after the first build, so a changed file fails readiness.
EXPECTED_MODEL_SHA256 = {
    key: value
    for key, value in (
        ("segmentation", os.environ.get("HOMR_EXPECTED_SEGMENTATION_SHA256", "")),
        ("encoder", os.environ.get("HOMR_EXPECTED_ENCODER_SHA256", "")),
        ("decoder", os.environ.get("HOMR_EXPECTED_DECODER_SHA256", "")),
    )
    if value
}

app = create_provider_app(
    use_gpu=False,
    homr_commit=HOMR_COMMIT,
    service_revision=SERVICE_REVISION,
    max_page_bytes=MAX_PAGE_BYTES,
    hard_timeout_seconds=PROCESS_TIMEOUT_SECONDS,
    ready_wait_seconds=READY_WAIT_SECONDS,
    provider_token=PROVIDER_TOKEN,
    idempotency_cache_size=CACHE_LIMIT,
    expected_model_sha256=EXPECTED_MODEL_SHA256,
)
