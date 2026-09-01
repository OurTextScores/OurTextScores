"""CUDA-only ONNX session construction for the pinned rareNum core."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from runtime_identity import require_artifact


class CoreLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class RareNumSessions:
    encoder: object
    decoder: object
    structured_heads: object
    execution_provider: str


def load_rare_num_sessions(*, encoder: Path, decoder: Path, heads: Path, encoder_sha256: str, decoder_sha256: str, heads_sha256: str) -> RareNumSessions:
    """Open all graphs before readiness; never silently fall back to CPU."""
    require_artifact(encoder, encoder_sha256)
    require_artifact(decoder, decoder_sha256)
    require_artifact(heads, heads_sha256)
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise CoreLoadError("onnxruntime-gpu is not installed") from error
    available = ort.get_available_providers()
    if "CUDAExecutionProvider" not in available:
        raise CoreLoadError("CUDAExecutionProvider is unavailable")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    providers = ["CUDAExecutionProvider"]
    try:
        sessions = [ort.InferenceSession(str(path), sess_options=options, providers=providers) for path in (encoder, decoder, heads)]
    except Exception as error:
        raise CoreLoadError("Pinned rareNum ONNX graph could not be loaded") from error
    if any("CUDAExecutionProvider" not in session.get_providers() for session in sessions):
        raise CoreLoadError("Pinned rareNum graph did not bind CUDAExecutionProvider")
    return RareNumSessions(*sessions, execution_provider="CUDAExecutionProvider")
