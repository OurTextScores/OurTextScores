"""Separate LOCAL-TEST provider that runs fusion-v1 with the pinned calibration/fusion-v1.json.

Deploy under its own app name; it never touches the shipping `ourtextscores-ots-homr-scanner`
app. Lyrics are calibrated by the checked-in manifest; directions and dynamics stay in review.
Importing builds Modal resources only.
"""

from __future__ import annotations

import modal

from modal_app import HARD_TIMEOUT_SECONDS, SOURCE_COMMIT, hf_secret, image, model_cache

SERVICE_REVISION = "ots-homr-fusion-calibrated-localtest-20261008-v1"

app = modal.App("ourtextscores-ots-homr-fusion-localtest")


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
    import json
    from pathlib import Path

    from bootstrap import bootstrap
    from calibration_manifest import load_calibration_manifest
    from fusion_policy import CLASS_ALLOWLIST
    from homr_core import PatchedHomrCore
    from ots_engine import OtsHomrEngine
    from ots_homr_provider import create_provider_app
    from pins import FUSION_DETECTORS

    artifacts = bootstrap(root=Path("/models/ots-homr"), device="cuda")
    model_cache.commit()
    core = PatchedHomrCore(
        artifacts=artifacts, hard_timeout_seconds=HARD_TIMEOUT_SECONDS
    )
    manifest = load_calibration_manifest(
        Path("/opt/ots-homr-provider/calibration/fusion-v1.json")
    )
    for detector_id in FUSION_DETECTORS:
        detector = artifacts.detectors[detector_id]
        manifest.assert_detector_matches(
            detector_id, revision=detector.revision, sha256=detector.sha256
        )
        if manifest.class_allowlist.get(detector_id) != CLASS_ALLOWLIST[detector_id]:
            raise RuntimeError("Fusion manifest has incompatible class ownership")

    class LoggingEngine(OtsHomrEngine):
        """Test-only: log the fusion tally; the production response path is unchanged."""

        def transcribe_fusion(self, *args, **kwargs):
            result = super().transcribe_fusion(*args, **kwargs)
            fused = result["fusion"]
            print(
                "FUSION-LOCALTEST regions=%d summary=%s"
                % (len(fused.regions), json.dumps(fused.summary)),
                flush=True,
            )
            return result

    engine = LoggingEngine(artifacts=artifacts, core=core, fusion_manifest=manifest)
    return create_provider_app(
        engine=engine,
        service_revision=SERVICE_REVISION,
        provider_source_commit=SOURCE_COMMIT,
    )
