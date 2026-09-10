"""Bridge verified rareNum artifacts into the hardened HOMR worker."""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pins import CORE_SHA256, TRAINING_REVISION

MODEL_NAME = f"pytorch_model_464-{TRAINING_REVISION}-rareNum"
SEGMENTATION_SHA256 = "60f495496cb41473c0521d0811d8f44b9d5cff892d287974a8aebb3eaee2fa83"


def install_runtime_artifacts(artifacts: Any, *, homr_root: Path) -> None:
    """Install verified files under the names the patched HOMR config resolves."""
    transformer = homr_root / "homr" / "transformer"
    transformer.mkdir(parents=True, exist_ok=True)
    targets = {
        artifacts.encoder: transformer / f"encoder_{MODEL_NAME}_fp16.onnx",
        artifacts.decoder: transformer / f"decoder_{MODEL_NAME}_fp16.onnx",
        artifacts.heads: transformer / f"structured_heads_{MODEL_NAME}.onnx",
    }
    for source, target in targets.items():
        # Copy the verified graphs into the ordinary container filesystem
        # before spawning, so inference does not retain a runtime dependency
        # on volume-backed links.
        if os.path.lexists(target):
            target.unlink()
        shutil.copyfile(source, target)
    os.environ["HOMR_MODEL_NAME"] = MODEL_NAME


class PatchedHomrCore:
    """Own the long-lived, hard-timeout HOMR child using rareNum graphs."""

    def __init__(
        self,
        *,
        artifacts: Any,
        homr_root: Path = Path("/opt/homr"),
        hard_timeout_seconds: int = 280,
        startup_timeout_seconds: int = 240,
        engine_factory: Callable[..., Any] | None = None,
    ) -> None:
        install_runtime_artifacts(artifacts, homr_root=homr_root)
        # Import only after HOMR_MODEL_NAME and graph paths have been installed;
        # default_config snapshots these paths at module import time.
        if engine_factory is None:
            from homr_engine import HomrEngine

            engine_factory = HomrEngine

        common = {
            "use_gpu": True,
            "homr_commit": TRAINING_REVISION,
            "hard_timeout_seconds": hard_timeout_seconds,
            "startup_timeout_seconds": startup_timeout_seconds,
            "expected_model_sha256": {
                "segmentation": SEGMENTATION_SHA256,
                "encoder": CORE_SHA256["encoder.onnx"],
                "decoder": CORE_SHA256["decoder.onnx"],
            },
        }
        heads_path = (
            homr_root / "homr" / "transformer" / f"structured_heads_{MODEL_NAME}.onnx"
        )
        self._plain = engine_factory(**common, structured_heads_path="")
        self._with_heads = engine_factory(
            **common, structured_heads_path=str(heads_path)
        )

    def warm_up(self) -> None:
        self._plain.warm_up()
        self._with_heads.warm_up()

    def is_ready(self) -> bool:
        return self._plain.is_ready() and self._with_heads.is_ready()

    def transcribe_both(
        self,
        page: bytes,
        content_type: str,
        detect_title: bool,
        score_profile: Any = None,
    ) -> dict[str, dict[str, Any]]:
        suffix = ".png" if content_type == "image/png" else ".jpg"
        # Both candidates are first-class outputs. Selection belongs to the
        # consuming Scanner job, so changing it never repeats GPU inference.
        return {
            "core": self._plain.transcribe(page, suffix, detect_title, score_profile),
            "additional-heads": self._with_heads.transcribe(
                page, suffix, detect_title, score_profile
            ),
        }

    def regenerate(self, staffs: list[list[list[str]]], title: str = "") -> bytes:
        result = self._plain.regenerate(staffs, title)
        if not result.get("ok") or not isinstance(result.get("musicxml"), bytes):
            raise RuntimeError("OTS-HOMR could not regenerate reviewed MusicXML")
        return result["musicxml"]

    def materialize_structured(
        self,
        staffs: list[list[list[str]]],
        structured: list[list[dict[str, Any] | None]],
        families: list[str],
        title: str = "",
    ) -> bytes:
        result = self._with_heads.regenerate(
            staffs, title, structured=structured, families=families
        )
        if not result.get("ok") or not isinstance(result.get("musicxml"), bytes):
            raise RuntimeError("OTS-HOMR could not materialize structured MusicXML")
        return result["musicxml"]

    def shutdown(self) -> None:
        self._plain.shutdown()
        self._with_heads.shutdown()
