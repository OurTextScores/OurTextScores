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
SERVICE_REVISION = "ots-homr-modal-v2"
MAX_PAGE_BYTES = 25 * 1024 * 1024

# Timeout ladder (design section 9.3). The provider must give up before the
# caller does, or an abandoned page keeps billing GPU time after OTS has already
# classified the call as failed. A cold request may spend READY_WAIT waiting for
# warm-up and then HARD_TIMEOUT on inference, so it is their SUM that has to stay
# under the caller's timeout:
#
#   READY_WAIT + HARD_TIMEOUT  <  OTS SCANNER_PROVIDER_TIMEOUT_MS  <  FUNCTION_TIMEOUT
#      150     +     400       <             600                   <       660
READY_WAIT_SECONDS = int(os.environ.get("HOMR_READY_WAIT_SECONDS", "150"))
HARD_TIMEOUT_SECONDS = int(os.environ.get("HOMR_HARD_TIMEOUT_SECONDS", "400"))
FUNCTION_TIMEOUT_SECONDS = int(os.environ.get("HOMR_FUNCTION_TIMEOUT_SECONDS", "660"))

# Supply chain (design section 9.5). The base is pinned by manifest-list digest
# so a rebuild cannot silently pick up a different CUDA runtime; the digest still
# resolves per-platform. Refresh it deliberately with:
#   docker buildx imagetools inspect nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04
CUDA_BASE_TAG = "nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04"
CUDA_BASE_DIGEST = "sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb"
CUDA_BASE = os.environ.get(
    "HOMR_CUDA_BASE", f"{CUDA_BASE_TAG.split(':')[0]}@{CUDA_BASE_DIGEST}"
)
POETRY_VERSION = "2.3.2"
POETRY_EXPORT_PLUGIN_VERSION = "1.9.0"
# Weight pins, captured from /v1/capabilities on the first successful GPU
# deployment (2026-08-08) and verified again after the onnxruntime fix. A
# changed weight file now fails readiness instead of quietly altering results.
#
# These are pins, not secrets, so they live here beside HOMR_COMMIT and
# CUDA_BASE_DIGEST rather than in a shell export: an export that is forgotten
# silently produces an UNPINNED image, because an empty value is dropped below
# and nothing fails. Committed, they cannot be forgotten.
#
# The GPU path loads fp16 weights, so these differ from the CPU image's hashes.
# Re-capture with `npm run scanner:modal:check` if HOMR_COMMIT ever moves.
DEFAULT_MODEL_SHA256 = {
    "segmentation": "60f495496cb41473c0521d0811d8f44b9d5cff892d287974a8aebb3eaee2fa83",
    "encoder": "cd2da3ddec91af046d274506947f01da079c4ec5908ba0dd4c0c5985f780c82a",
    "decoder": "58d55eebe22788ce98f0fc7730480a79c9f56534db064e8d32b1d5fe2579904a",
}
EXPECTED_MODEL_SHA256 = {
    key: value
    for key, value in (
        (
            "segmentation",
            os.environ.get(
                "HOMR_EXPECTED_SEGMENTATION_SHA256", DEFAULT_MODEL_SHA256["segmentation"]
            ),
        ),
        (
            "encoder",
            os.environ.get("HOMR_EXPECTED_ENCODER_SHA256", DEFAULT_MODEL_SHA256["encoder"]),
        ),
        (
            "decoder",
            os.environ.get("HOMR_EXPECTED_DECODER_SHA256", DEFAULT_MODEL_SHA256["decoder"]),
        ),
    )
    if value
}

SHARED = Path(__file__).resolve().parent.parent / "homr-provider"


def _source_commit() -> str:
    """The OTS commit being deployed, for the AGPL section 13 source link.

    Pointing at `main` would name whatever main happens to be later, not the
    revision actually serving. Refuse deployment without an immutable commit:
    this identity is checked by OTS before it accepts a scan result.
    """
    import subprocess

    override = os.environ.get("OTS_SOURCE_COMMIT", "").strip()
    if override:
        commit = override
    else:
        try:
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(Path(__file__).resolve().parent),
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            ).stdout.strip()
        except Exception as error:
            raise RuntimeError(
                "Set OTS_SOURCE_COMMIT to the immutable OurTextScores source commit"
            ) from error
    if len(commit) not in (40, 64) or any(c not in "0123456789abcdef" for c in commit):
        raise RuntimeError("OTS source commit is not an immutable git object id")
    return commit


SOURCE_COMMIT = _source_commit()

image = (
    modal.Image.from_registry(CUDA_BASE, add_python="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0", "libgomp1", "ca-certificates")
    # Must precede run_commands: the install below reads it. The shared provider
    # directory is mounted at the end of the build, too late for this.
    .add_local_file(
        SHARED / "security-overrides.txt",
        remote_path="/tmp/security-overrides.txt",
        copy=True,
    )
    .run_commands(
        "git clone https://github.com/liebharc/homr.git /opt/homr",
        f"cd /opt/homr && git checkout --detach {HOMR_COMMIT}",
        f"cd /opt/homr && test \"$(git rev-parse HEAD)\" = {HOMR_COMMIT}",
        f"python -m pip install --no-cache-dir 'poetry=={POETRY_VERSION}' "
        f"'poetry-plugin-export=={POETRY_EXPORT_PLUGIN_VERSION}'",
        # Resolve from HOMR's committed poetry.lock, but install with pip under
        # --require-hashes rather than `poetry install`. It verifies every
        # artifact against the lockfile hashes (design section 9.5), and it keeps
        # poetry out of the install itself — `poetry install` fails on Modal's
        # add_python interpreter, whose bundled pip records a build-time wheel
        # path (/build/pip-*.whl) that does not exist in the image.
        "cd /opt/homr && poetry export --only main --extras gpu "
        "-f requirements.txt -o /tmp/homr-requirements.txt",
        # HOMR depends on `onnxruntime`, and its `gpu` extra adds
        # `onnxruntime-gpu`, so the lockfile export contains both. They install
        # the same import name over the same files: whichever pip writes last
        # wins, and the CPU wheel sorts after the GPU one, which silently strips
        # CUDAExecutionProvider. `onnxruntime-gpu` is a superset — it still
        # offers CPUExecutionProvider — so drop the CPU-only distribution.
        # Entries start at column 0; hash lines are indented continuations.
        "awk '/^onnxruntime==/{drop=1;next} /^[^[:space:]]/{drop=0} !drop' "
        "/tmp/homr-requirements.txt > /tmp/homr-gpu-requirements.txt "
        "&& mv /tmp/homr-gpu-requirements.txt /tmp/homr-requirements.txt",
        "python -m pip install --no-cache-dir --require-hashes "
        "-r /tmp/homr-requirements.txt",
        # Lifts the HOMR-pinned packages carrying known HIGH advisories, with the
        # same hash verification. Shared with the CPU image so both providers run
        # the same versions.
        "python -m pip install --no-cache-dir --require-hashes "
        "-r /tmp/security-overrides.txt",
        "rm -f /tmp/security-overrides.txt",
        # Fail the build, not a scan, if the CPU distribution ever returns.
        "python -m pip show onnxruntime-gpu > /dev/null",
        "if python -m pip show onnxruntime > /dev/null 2>&1; then "
        "echo 'onnxruntime (CPU) must not be installed beside onnxruntime-gpu'; "
        "exit 1; fi",
        "python -m pip install --no-cache-dir --no-deps /opt/homr",
        "python -m pip uninstall -y poetry poetry-plugin-export && "
        "rm -f /tmp/homr-requirements.txt",
        "python -m pip install --no-cache-dir "
        "'fastapi==0.116.1' 'httpx==0.28.1' 'python-multipart==0.0.30'",
        # Bake the weights in so readiness never waits on a download.
        "cd /opt/homr && homr --init --gpu force",
    )
    .env(
        {
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": "/opt/ots-homr-provider",
            "HOMR_COMMIT": HOMR_COMMIT,
            # Modal re-imports this module inside the container, so anything
            # read from the deploy-time environment has to be baked in or the
            # container would silently fall back to the defaults.
            "HOMR_HARD_TIMEOUT_SECONDS": str(HARD_TIMEOUT_SECONDS),
            "HOMR_READY_WAIT_SECONDS": str(READY_WAIT_SECONDS),
            # Resolved at deploy time; the container has no git checkout.
            "OTS_SOURCE_COMMIT": SOURCE_COMMIT,
            **{
                f"HOMR_EXPECTED_{name.upper()}_SHA256": value
                for name, value in EXPECTED_MODEL_SHA256.items()
            },
        }
    )
    .add_local_dir(
        SHARED,
        remote_path="/opt/ots-homr-provider",
        copy=True,
        ignore=["__pycache__", "*.pyc"],
    )
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
        provider_source_commit=SOURCE_COMMIT,
        max_page_bytes=MAX_PAGE_BYTES,
        hard_timeout_seconds=HARD_TIMEOUT_SECONDS,
        ready_wait_seconds=READY_WAIT_SECONDS,
        # Modal proxy authentication fronts the app; no second shared secret.
        provider_token="",
        expected_model_sha256=EXPECTED_MODEL_SHA256,
    )
