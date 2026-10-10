"""Pinned Modal deployment shell for the private rareNum OTS-HOMR provider."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

HOMR_COMMIT = "b6eca7c6af37df2764a9ca99033c947eb42aae90"
SERVICE_REVISION = "ots-ots-homr-provider-v8"
HARD_TIMEOUT_SECONDS = 280
CUDA_BASE = "nvidia/cuda@sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb"
HERE = Path(__file__).resolve().parent
#: Where the provider sources live inside the image (the app file itself is copied elsewhere, so HERE is wrong there).
PROVIDER_ROOT = "/opt/ots-homr-provider"
PATCH = HERE / "patches" / "homr-runtime-glue.patch"
# HOMR 40fe6a6: a piano grand staff the detector merges into one staff matches a voice+piano profile (the profile-layout
# check used to report "expects 3, detected 2" on correct pages). Only score_profile.py and score_profile_layout.py differ
# from the pinned archive; applied as its own layer so the heavy dependency layers above stay cached.
GRAND_STAFF_PATCH = HERE / "patches" / "homr-grand-staff-profile-layout.patch"
GRAND_STAFF_PATCH_SHA256 = "6534e017f1eb597c8543adb63130c213bd67d7fa191d7f969d1b35de8f922b44"
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
    # Hash-pinned lyric/direction OCR stack (RapidOCR bundles its models; lyric_ocr.py re-verifies them by SHA-256 at
    # start). Installed whether or not fusion is enabled: it is inert until the engine is given the pipeline, and
    # keeping it below the heavy layers above and above the frequently edited source layers below keeps rebuilds cheap.
    .add_local_file(
        HERE / "ocr-requirements.txt", remote_path="/tmp/ocr-requirements.txt", copy=True
    )
    .run_commands(
        "python -m pip install --no-cache-dir --require-hashes --no-deps -r /tmp/ocr-requirements.txt",
        "python -c 'import rapidocr; print(rapidocr.__file__)'",
    )
    .add_local_file(
        GRAND_STAFF_PATCH, remote_path="/tmp/homr-grand-staff-profile-layout.patch", copy=True
    )
    .run_commands(
        f"echo '{GRAND_STAFF_PATCH_SHA256}  /tmp/homr-grand-staff-profile-layout.patch' | sha256sum --check --strict",
        "cd /opt/homr && git apply --check /tmp/homr-grand-staff-profile-layout.patch && git apply /tmp/homr-grand-staff-profile-layout.patch",
        # The patched module must be the one imported (PYTHONPATH puts /opt/homr ahead of the pip-installed copy).
        "cd /tmp && PYTHONPATH=/opt/homr python -c \"import homr.score_profile as m; assert m.__file__.startswith('/opt/homr/'), m.__file__; assert hasattr(m.ScoreProfile, 'unit_pattern_for')\"",
    )
    .add_local_dir(
        HOMR_SHARED,
        remote_path="/opt/homr-provider-support",
        copy=True,
        ignore=["__pycache__", "*.pyc", "test_*.py"],
    )
    .add_local_dir(
        HERE,
        remote_path=PROVIDER_ROOT,
        copy=True,
        ignore=["__pycache__", "*.pyc", "patches", "source/"],
    )
    .env(
        {
            "PYTHONPATH": (
                f"/opt/homr:{PROVIDER_ROOT}:/opt/homr-provider-support"
            ),
            "PYTHONUNBUFFERED": "1",
            "HOMR_WARMUP_PAGE": "/opt/homr-provider-support/warmup-page.png",
            "HOMR_REQUIRE_CUDA": "1",
            "OTS_SOURCE_COMMIT": SOURCE_COMMIT,
            # Text fusion with review-assisted lyrics, directions and dynamics. Off unless the deployer sets it:
            # `OTS_HOMR_FUSION_ENABLED=1 modal deploy modal_app.py`. Off, the service behaves as v7 did.
            "OTS_HOMR_FUSION_ENABLED": os.environ.get("OTS_HOMR_FUSION_ENABLED", "0"),
        }
    )
)

# The production App name. Only a pre-flight deployment overrides it (a separate App, never the live one).
app = modal.App(os.environ.get("OTS_HOMR_APP_NAME", "ourtextscores-ots-homr-scanner"))


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
    from calibration_manifest import load_calibration_manifest
    from homr_core import PatchedHomrCore
    from ots_engine import OtsHomrEngine
    from ots_homr_provider import create_provider_app

    artifacts = bootstrap(root=Path("/models/ots-homr"), device="cuda")
    model_cache.commit()
    core = PatchedHomrCore(
        artifacts=artifacts,
        hard_timeout_seconds=HARD_TIMEOUT_SECONDS,
        paired_tremolo_timing=os.environ.get("OTS_HOMR_PAIRED_TREMOLO_TIMING") == "1",
    )
    fusion_manifest = None
    if os.environ.get("OTS_HOMR_FUSION_ENABLED") == "1":
        # The manifest is deliberately absent until both models have a
        # score-disjoint calibration. Enabling fusion before it lands prevents
        # readiness rather than silently using lyrics-only calibration.
        # The container path, not HERE: modal_app.py itself is copied to /root, the provider sources to PROVIDER_ROOT.
        fusion_manifest = load_calibration_manifest(
            Path(PROVIDER_ROOT) / "calibration" / "fusion-v1.json"
        )
        if fusion_manifest.policy != "fusion-v1":
            raise RuntimeError("Fusion needs its own pinned calibration")
        from pins import FUSION_DETECTORS
        from fusion_policy import CLASS_ALLOWLIST

        for detector_id in FUSION_DETECTORS:
            detector = artifacts.detectors[detector_id]
            fusion_manifest.assert_detector_matches(
                detector_id, revision=detector.revision, sha256=detector.sha256
            )
            if (
                fusion_manifest.class_allowlist.get(detector_id)
                != CLASS_ALLOWLIST[detector_id]
            ):
                raise RuntimeError(
                    "Fusion calibration has incompatible logical class ownership"
                )
    lyric_text = dynamics_reader = None
    if fusion_manifest is not None:
        # OCR rows (lyrics, written directions, dynamics) and the dynamics classifier read the page the fusion pass
        # already detected on. Both verify their pinned models/weights by SHA-256 and fail the start, not the page,
        # when they differ; a runtime failure on a page only drops that page's rows (see ots_engine).
        from dynamics_reader import DynamicsReader
        from lyric_ocr import LyricTextPipeline
        from semantic_gate import SemanticGate

        lyric_text = LyricTextPipeline(SemanticGate.load(), threads=2)
        dynamics_reader = DynamicsReader()
    engine = OtsHomrEngine(
        artifacts=artifacts,
        core=core,
        fusion_manifest=fusion_manifest,
        lyric_text=lyric_text,
        dynamics_reader=dynamics_reader,
    )
    return create_provider_app(
        engine=engine,
        service_revision=SERVICE_REVISION,
        provider_source_commit=SOURCE_COMMIT,
    )
