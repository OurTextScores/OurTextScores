"""Pinned Modal deployment shell for the private rareNum OTS-HOMR provider."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

HOMR_COMMIT = "b6eca7c6af37df2764a9ca99033c947eb42aae90"
SERVICE_REVISION = "ots-ots-homr-provider-v7"
HARD_TIMEOUT_SECONDS = 280
CUDA_BASE = "nvidia/cuda@sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb"
HERE = Path(__file__).resolve().parent
PATCH = HERE / "patches" / "homr-runtime-glue.patch"
SOURCE_ARCHIVE = HERE / "source" / "homr-b6eca7-source.tar.gz"
SOURCE_ARCHIVE_SHA256 = (
    "999d5071fe9bcfab8dc1534ec1614e125888651fcc6c72a9862bc605ba38d1a2"
)
HOMR_SHARED = HERE.parent / "homr-provider"


def _source_commit() -> str:
    commit = os.environ.get("OTS_SOURCE_COMMIT", "").strip()
    if not commit:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=HERE,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    if len(commit) not in (40, 64) or any(
        character not in "0123456789abcdef" for character in commit
    ):
        raise RuntimeError("OTS source commit is not an immutable git object id")
    return commit


SOURCE_COMMIT = _source_commit()

# The secret has only a read-scoped HF token. It is deliberately not present in
# the Scanner API, worker, response envelope, image definition, or source tree.
hf_secret = modal.Secret.from_name("ots-homr-hf-read", required_keys=["HF_TOKEN"])
model_cache = modal.Volume.from_name("ots-homr-private-models", create_if_missing=True)

image = (
    modal.Image.from_registry(CUDA_BASE, add_python="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0", "libgomp1", "ca-certificates")
    .add_local_file(PATCH, remote_path="/tmp/homr-runtime-glue.patch", copy=True)
    .add_local_file(
        SOURCE_ARCHIVE, remote_path="/tmp/homr-b6eca7-source.tar.gz", copy=True
    )
    .add_local_file(
        HOMR_SHARED / "security-overrides.txt",
        remote_path="/tmp/security-overrides.txt",
        copy=True,
    )
    .run_commands(
        f"echo '{SOURCE_ARCHIVE_SHA256}  /tmp/homr-b6eca7-source.tar.gz' | sha256sum --check --strict",
        "mkdir -p /opt && tar -xzf /tmp/homr-b6eca7-source.tar.gz -C /opt",
        "cd /opt/homr && git apply --check /tmp/homr-runtime-glue.patch && git apply /tmp/homr-runtime-glue.patch",
        "python -m pip install --no-cache-dir 'poetry==2.3.2' 'poetry-plugin-export==1.9.0'",
        "cd /opt/homr && poetry export --only main --extras gpu -f requirements.txt -o /tmp/homr-requirements.txt",
        "awk '/^onnxruntime==/{drop=1;next} /^[^[:space:]]/{drop=0} !drop' /tmp/homr-requirements.txt > /tmp/homr-gpu-requirements.txt && mv /tmp/homr-gpu-requirements.txt /tmp/homr-requirements.txt",
        "python -m pip install --no-cache-dir --require-hashes -r /tmp/homr-requirements.txt",
        "python -m pip install --no-cache-dir --require-hashes -r /tmp/security-overrides.txt",
        # The clean source archive deliberately has no .git directory. HOMR's
        # dynamic-versioning backend otherwise fails while preparing metadata.
        # Use the static fallback already declared in its pyproject.toml.
        "POETRY_DYNAMIC_VERSIONING_BYPASS=0.0.0 "
        "python -m pip install --no-cache-dir --no-deps /opt/homr",
        "python -m pip uninstall -y poetry poetry-plugin-export",
        "python -m pip install --no-cache-dir 'fastapi==0.116.1' 'python-multipart==0.0.30' 'huggingface_hub==0.34.4' 'segmentation-models-pytorch==0.5.0'",
        "python -m pip show onnxruntime-gpu > /dev/null",
        "if python -m pip show onnxruntime > /dev/null 2>&1; then "
        "echo 'onnxruntime CPU package must not shadow onnxruntime-gpu'; exit 1; fi",
    )
    .add_local_dir(
        HOMR_SHARED,
        remote_path="/opt/homr-provider-support",
        copy=True,
        ignore=["__pycache__", "*.pyc", "test_*.py"],
    )
    .add_local_dir(
        HERE,
        remote_path="/opt/ots-homr-provider",
        copy=True,
        ignore=["__pycache__", "*.pyc", "patches", "source/"],
    )
    .env(
        {
            "PYTHONPATH": (
                "/opt/homr:/opt/ots-homr-provider:/opt/homr-provider-support"
            ),
            "PYTHONUNBUFFERED": "1",
            "HOMR_WARMUP_PAGE": "/opt/homr-provider-support/warmup-page.png",
            "HOMR_REQUIRE_CUDA": "1",
            "OTS_SOURCE_COMMIT": SOURCE_COMMIT,
        }
    )
)

app = modal.App("ourtextscores-ots-homr-scanner")


@app.function(
    image=image,
    gpu="L4",
    timeout=660,
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    secrets=[hf_secret],
    volumes={"/models": model_cache},
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app(requires_proxy_auth=True)
def ots_homr_api():
    from pathlib import Path

    from bootstrap import bootstrap
    from homr_core import PatchedHomrCore
    from ots_engine import OtsHomrEngine
    from ots_homr_provider import create_provider_app

    artifacts = bootstrap(root=Path("/models/ots-homr"), device="cuda")
    model_cache.commit()
    core = PatchedHomrCore(
        artifacts=artifacts,
        hard_timeout_seconds=HARD_TIMEOUT_SECONDS,
    )
    engine = OtsHomrEngine(artifacts=artifacts, core=core)
    return create_provider_app(
        engine=engine,
        service_revision=SERVICE_REVISION,
        provider_source_commit=SOURCE_COMMIT,
    )
