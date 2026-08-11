"""Supervised Transcoda inference and kern-to-MusicXML conversion.

The model lives in one long-running child process so its CUDA weights stay warm.
The parent owns the wall-clock timeout: killing the child is the only reliable
way to stop a wedged native PyTorch/CUDA call. A replacement starts cold and is
not ready until it passes warm-up again.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import io
import multiprocessing
import re
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CODE_FAILED = "inference_failed"
CODE_GENERATION_FAILED = "generation_failed"
CODE_INVALID_IMAGE = "invalid_image"
CODE_NO_STAFF = "no_staff_detected"
CODE_NOT_READY = "model_not_ready"
CODE_TIMEOUT = "inference_timeout"

_DOCTYPE = re.compile(rb"<!DOCTYPE\b", re.IGNORECASE)
_ENTITY = re.compile(rb"<!ENTITY\b", re.IGNORECASE)


class InferenceError(RuntimeError):
    """A classified failure with caller-safe text and private diagnostic detail."""

    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


@dataclass
class EngineProvenance:
    model_artifact: str = ""
    model_revision: str = ""
    model_artifact_sha256: str = ""
    transcoda_commit: str = ""
    execution_provider: str = ""
    available_execution_providers: list[str] = field(default_factory=list)
    accelerator: str = ""
    converter: str = ""
    converter_version: str = ""
    encoder_artifact: str = ""
    encoder_revision: str = ""
    encoder_artifact_sha256: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "modelArtifact": self.model_artifact,
            "modelRevision": self.model_revision,
            "modelArtifactSha256": self.model_artifact_sha256,
            "transcodaCommit": self.transcoda_commit,
            "executionProvider": self.execution_provider,
            "availableExecutionProviders": list(self.available_execution_providers),
            "accelerator": self.accelerator,
            "converter": self.converter,
            "converterVersion": self.converter_version,
            "encoderArtifact": self.encoder_artifact,
            "encoderRevision": self.encoder_revision,
            "encoderArtifactSha256": self.encoder_artifact_sha256,
        }


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def strip_musicxml_doctype(document: bytes) -> bytes:
    """Remove music21's simple external DOCTYPE and reject active declarations.

    music21 emits one simple `<!DOCTYPE ...>` before the score root. The scanner
    deliberately refuses DTDs and entities, so conversion removes that known
    serialization detail. Internal subsets and entity declarations are not
    normalized; they are rejected so this helper cannot become an XML sanitizer.
    """
    match = _DOCTYPE.search(document)
    if match is None:
        if _ENTITY.search(document):
            raise ValueError("MusicXML contains an entity declaration")
        return document

    end = document.find(b">", match.start())
    if end < 0:
        raise ValueError("MusicXML contains an unterminated doctype")
    declaration = document[match.start() : end + 1]
    if b"[" in declaration or _ENTITY.search(document):
        raise ValueError("MusicXML contains an active DTD declaration")

    # Remove at most one declaration and its following line break. Anything
    # more complicated is not the music21 form we intentionally support.
    following = end + 1
    if document[following : following + 2] == b"\r\n":
        following += 2
    elif document[following : following + 1] == b"\n":
        following += 1
    result = document[: match.start()] + document[following:]
    if _DOCTYPE.search(result) or _ENTITY.search(result):
        raise ValueError("MusicXML contains more than one DTD declaration")
    return result


def _convert_kern_to_musicxml(kern: bytes) -> bytes:
    """Convert canonical kern with music21 and remove its external DTD."""
    from music21 import converter

    with tempfile.TemporaryDirectory(prefix="ots-transcoda-convert-") as directory:
        source = Path(directory) / "page.krn"
        target = Path(directory) / "page.musicxml"
        source.write_bytes(kern)
        score = converter.parse(str(source), format="humdrum")
        score.write("musicxml", fp=str(target))
        document = strip_musicxml_doctype(target.read_bytes())
    if b"<score-partwise" not in document and b"<score-timewise" not in document:
        raise ValueError("music21 produced no MusicXML score root")
    return document


def _canonical_kern_body(text: str) -> bytes:
    """Add the syntax wrappers intentionally omitted from model targets.

    Transcoda's released targets contain the body only. The upstream inference
    script prepends a `**kern` header and appends spine terminators after decode.
    We do the same, deriving the field count so malformed width is not hidden by
    the upstream script's two-spine literal.
    """
    from src.core.kern_postprocess import append_terminator_if_missing

    body = text.strip("\n")
    if not body:
        raise InferenceError(CODE_NO_STAFF, "Transcoda produced no notation")
    first_record = next(
        (
            line
            for line in body.splitlines()
            if line.strip() and not line.startswith("!!")
        ),
        "",
    )
    if not first_record:
        raise InferenceError(CODE_NO_STAFF, "Transcoda produced no notation")
    field_count = len(first_record.split("\t"))
    header = "\t".join(["**kern"] * field_count)
    canonical = append_terminator_if_missing(f"{header}\n{body}")
    return (canonical.rstrip("\n") + "\n").encode("utf-8")


def _child_main(
    connection: Any,
    use_gpu: bool,
    checkpoint_path: str,
    model_artifact: str,
    model_revision: str,
    model_artifact_sha256: str,
    transcoda_commit: str,
    encoder_artifact: str,
    encoder_revision: str,
    encoder_artifact_sha256: str,
    encoder_path: str,
) -> None:
    """Own the model, CUDA context, and conversion dependencies."""
    try:
        import torch
        from PIL import Image
        from src.data.preprocessing import preprocess_pil_image
        from src.grammar.semantic_sequence_finalizer import (
            finalize_generated_kern_sequence,
        )
        from src.model.checkpoint_loader import load_model_from_checkpoint
        from src.model.encoder import EncoderLoader
        from src.model.generation_policy import (
            apply_generation_overrides,
            build_generate_kwargs,
            settings_from_decoding_spec,
        )

        if use_gpu and not torch.cuda.is_available():
            raise RuntimeError("torch.cuda is unavailable")
        device = torch.device("cuda" if use_gpu else "cpu")

        # Verify bytes before `torch.load(..., weights_only=False)` touches the
        # pickle-backed Lightning checkpoint, and before Transformers reads the
        # encoder snapshot. Readiness-only verification would be too late.
        checkpoint_sha256 = sha256_file(checkpoint_path)
        if checkpoint_sha256 != model_artifact_sha256:
            raise RuntimeError("The model artifact does not match its pinned SHA-256")
        encoder_sha256 = sha256_file(Path(encoder_path) / "model.safetensors")
        if encoder_sha256 != encoder_artifact_sha256:
            raise RuntimeError(
                "The encoder bootstrap does not match its pinned SHA-256"
            )

        # The checkpoint records a Hugging Face model ID and upstream constructs
        # that encoder with `from_pretrained` before overwriting its weights from
        # the checkpoint. Redirect that one expected ID to the baked, pinned
        # snapshot so a cold start cannot reach the network or follow `main`.
        original_load_transformers = EncoderLoader._load_transformers

        def load_pinned_encoder(config: Any) -> tuple[Any, int]:
            if config.encoder_model_name_or_path != encoder_artifact:
                raise RuntimeError(
                    "The checkpoint requested an unexpected encoder artifact: "
                    f"{config.encoder_model_name_or_path}"
                )
            config.encoder_model_name_or_path = encoder_path
            return original_load_transformers(config)

        EncoderLoader._load_transformers = staticmethod(load_pinned_encoder)
        try:
            loaded = load_model_from_checkpoint(checkpoint_path, device)
        finally:
            EncoderLoader._load_transformers = staticmethod(original_load_transformers)
        settings = apply_generation_overrides(
            settings_from_decoding_spec(loaded.artifact.decoding),
            strategy="beam",
            num_beams=3,
            length_penalty=1.0,
            repetition_penalty=1.1,
        )
        available = ["torch.cpu"]
        accelerator = "CPU"
        if torch.cuda.is_available():
            available.insert(0, "torch.cuda")
            accelerator = torch.cuda.get_device_name(0)
        provenance = EngineProvenance(
            model_artifact=model_artifact,
            model_revision=model_revision,
            model_artifact_sha256=checkpoint_sha256,
            transcoda_commit=transcoda_commit,
            execution_provider="torch.cuda" if use_gpu else "torch.cpu",
            available_execution_providers=available,
            accelerator=accelerator,
            converter="music21",
            converter_version=importlib.metadata.version("music21"),
            encoder_artifact=encoder_artifact,
            encoder_revision=encoder_revision,
            encoder_artifact_sha256=encoder_sha256,
        )
        connection.send({"kind": "ready", "provenance": provenance.as_dict()})
    except Exception as error:  # noqa: BLE001  # pragma: no cover - child boundary
        connection.send({"kind": "startup_failed", "detail": repr(error)[:2000]})
        return

    while True:
        try:
            request = connection.recv()
        except (EOFError, KeyboardInterrupt):
            return
        if request.get("kind") == "shutdown":
            return

        started = time.monotonic()
        try:
            try:
                image = Image.open(io.BytesIO(request["page"]))
                image.load()
                image = image.convert("RGB")
            except Exception as error:
                raise InferenceError(
                    CODE_INVALID_IMAGE,
                    "The page image could not be decoded",
                    repr(error)[:2000],
                ) from error

            pixel_values, model_input_size = preprocess_pil_image(
                image=image,
                image_width=loaded.image_width,
                fixed_size=loaded.fixed_size,
            )
            pixel_values = pixel_values.unsqueeze(0).to(device)
            max_length = 2048
            with torch.no_grad():
                token_tensor = loaded.model.generate(
                    **build_generate_kwargs(
                        pixel_values=pixel_values,
                        image_sizes=torch.tensor([model_input_size], device=device),
                        max_length=max_length,
                        settings=settings,
                    )
                )
            token_ids = token_tensor[0].tolist()
            finalized = finalize_generated_kern_sequence(
                token_ids=token_ids,
                i2w=loaded.i2w,
                bos_token_id=getattr(loaded.model.config, "bos_token_id", None),
                eos_token_id=getattr(loaded.model.config, "eos_token_id", None),
                pad_token_id=loaded.pad_token_id,
                max_length=max_length,
                rule_factories=(),
            )
            kern = _canonical_kern_body(finalized.text)
            try:
                musicxml = _convert_kern_to_musicxml(kern)
            except Exception as error:
                raise InferenceError(
                    CODE_GENERATION_FAILED,
                    "Transcoda recognised the page but conversion failed",
                    traceback.format_exc()[-2000:],
                ) from error
            connection.send(
                {
                    "ok": True,
                    "kern": kern,
                    "musicxml": musicxml,
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "generation": {
                        "hitMaxLength": bool(finalized.hit_max_length),
                        "sawEos": bool(finalized.saw_eos),
                        "truncated": bool(finalized.truncated),
                        "maxLength": max_length,
                        "numBeams": 3,
                    },
                }
            )
        except InferenceError as error:
            connection.send({"ok": False, "code": error.code, "detail": error.detail})
        except Exception:  # noqa: BLE001 - translate child failures at the IPC boundary
            connection.send(
                {
                    "ok": False,
                    "code": CODE_FAILED,
                    "detail": traceback.format_exc()[-2000:],
                }
            )


class TranscodaEngine:
    """Supervise one warm model process and serialize its requests."""

    def __init__(
        self,
        *,
        use_gpu: bool,
        checkpoint_path: str,
        model_artifact: str,
        model_revision: str,
        model_artifact_sha256: str,
        transcoda_commit: str,
        encoder_artifact: str,
        encoder_revision: str,
        encoder_artifact_sha256: str,
        encoder_path: str,
        converter: str,
        converter_version: str,
        hard_timeout_seconds: int,
        warmup_page_path: str,
        startup_timeout_seconds: int = 300,
    ) -> None:
        self._use_gpu = use_gpu
        self._checkpoint_path = checkpoint_path
        self._model_artifact = model_artifact
        self._model_revision = model_revision
        self._expected_model_sha256 = model_artifact_sha256.lower()
        self._transcoda_commit = transcoda_commit
        self._encoder_artifact = encoder_artifact
        self._encoder_revision = encoder_revision
        self._expected_encoder_sha256 = encoder_artifact_sha256.lower()
        self._encoder_path = encoder_path
        self._expected_converter = converter
        self._expected_converter_version = converter_version
        self._hard_timeout = hard_timeout_seconds
        self._warmup_page_path = warmup_page_path
        self._startup_timeout = startup_timeout_seconds
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._process: Any = None
        self._connection: Any = None
        self._ready = False
        self._warm = False
        self._last_error = ""
        self._provenance = EngineProvenance(
            model_artifact=model_artifact,
            model_revision=model_revision,
            transcoda_commit=transcoda_commit,
            converter=converter,
            converter_version=converter_version,
            encoder_artifact=encoder_artifact,
            encoder_revision=encoder_revision,
        )

    @property
    def expected_execution_provider(self) -> str:
        return "torch.cuda" if self._use_gpu else "torch.cpu"

    @property
    def provenance(self) -> EngineProvenance:
        return self._provenance

    @property
    def degraded_reason(self) -> str:
        return ""

    @property
    def last_error(self) -> str:
        return self._last_error

    def is_ready(self) -> bool:
        return bool(
            self._ready
            and self._warm
            and self._process is not None
            and self._process.is_alive()
        )

    def _ensure_child_locked(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        self._teardown_locked()
        parent, child = self._context.Pipe(duplex=True)
        process = self._context.Process(
            target=_child_main,
            args=(
                child,
                self._use_gpu,
                self._checkpoint_path,
                self._model_artifact,
                self._model_revision,
                self._expected_model_sha256,
                self._transcoda_commit,
                self._encoder_artifact,
                self._encoder_revision,
                self._expected_encoder_sha256,
                self._encoder_path,
            ),
            daemon=True,
        )
        process.start()
        child.close()
        self._process = process
        self._connection = parent
        if not parent.poll(self._startup_timeout):
            self._last_error = "The inference child did not start in time"
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")
        message = parent.recv()
        if message.get("kind") != "ready":
            self._last_error = str(message.get("detail", "startup failed"))[:2000]
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")
        values = message["provenance"]
        self._provenance = EngineProvenance(
            model_artifact=values["modelArtifact"],
            model_revision=values["modelRevision"],
            model_artifact_sha256=values["modelArtifactSha256"],
            transcoda_commit=values["transcodaCommit"],
            execution_provider=values["executionProvider"],
            available_execution_providers=list(values["availableExecutionProviders"]),
            accelerator=values["accelerator"],
            converter=values["converter"],
            converter_version=values["converterVersion"],
            encoder_artifact=values["encoderArtifact"],
            encoder_revision=values["encoderRevision"],
            encoder_artifact_sha256=values["encoderArtifactSha256"],
        )
        mismatch = self._provenance.model_artifact_sha256 != self._expected_model_sha256
        wrong_provider = (
            self.expected_execution_provider
            not in self._provenance.available_execution_providers
        )
        wrong_converter = (
            self._provenance.converter != self._expected_converter
            or self._provenance.converter_version != self._expected_converter_version
        )
        wrong_encoder = (
            self._provenance.encoder_artifact != self._encoder_artifact
            or self._provenance.encoder_revision != self._encoder_revision
            or self._provenance.encoder_artifact_sha256 != self._expected_encoder_sha256
        )
        if mismatch or wrong_provider or wrong_converter or wrong_encoder:
            self._last_error = (
                "The model artifact does not match its pinned SHA-256"
                if mismatch
                else (
                    f"{self.expected_execution_provider} is unavailable"
                    if wrong_provider
                    else (
                        "The converter does not match its pinned version"
                        if wrong_converter
                        else "The encoder bootstrap does not match its pinned artifact"
                    )
                )
            )
            self._teardown_locked()
            raise InferenceError(CODE_NOT_READY, self._last_error)
        self._ready = True

    def _teardown_locked(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except OSError:
                pass
            self._connection = None
        if self._process is not None:
            if self._process.is_alive():
                self._process.kill()
            self._process.join(timeout=10)
            self._process = None
        self._ready = False
        self._warm = False

    def shutdown(self) -> None:
        with self._lock:
            if self._connection is not None:
                try:
                    self._connection.send({"kind": "shutdown"})
                except (OSError, BrokenPipeError, ValueError):
                    pass
            self._teardown_locked()

    def warm_up(self) -> None:
        with self._lock:
            self._ensure_child_locked()
            try:
                page = Path(self._warmup_page_path).read_bytes()
            except OSError as error:
                self._last_error = repr(error)[:2000]
                raise InferenceError(
                    CODE_NOT_READY, "The warm-up page is unavailable"
                ) from error
            self._request_locked(
                {"kind": "transcribe", "page": page}, self._hard_timeout
            )
            self._warm = True

    def transcribe(self, page: bytes) -> dict[str, Any]:
        with self._lock:
            self._ensure_child_locked()
            return self._request_locked(
                {"kind": "transcribe", "page": page}, self._hard_timeout
            )

    def _request_locked(self, request: dict[str, Any], timeout: int) -> dict[str, Any]:
        connection = self._connection
        if connection is None:
            raise InferenceError(CODE_NOT_READY, "The inference worker is not ready")
        try:
            connection.send(request)
        except (OSError, BrokenPipeError, ValueError) as error:
            self._last_error = repr(error)[:2000]
            self._teardown_locked()
            raise InferenceError(
                CODE_FAILED, "The inference worker is unavailable"
            ) from error
        if not connection.poll(timeout):
            self._last_error = f"Inference exceeded {timeout}s"
            self._teardown_locked()
            raise InferenceError(CODE_TIMEOUT, "Transcoda exceeded the page time limit")
        try:
            response = connection.recv()
        except (EOFError, OSError) as error:
            self._last_error = repr(error)[:2000]
            self._teardown_locked()
            raise InferenceError(CODE_FAILED, "The inference worker stopped") from error
        if response.get("ok"):
            return response
        code = str(response.get("code") or CODE_FAILED)
        self._last_error = str(response.get("detail") or "")[:2000]
        messages = {
            CODE_INVALID_IMAGE: "The page image could not be decoded",
            CODE_NO_STAFF: "No notation was detected on this page",
            CODE_GENERATION_FAILED: "The recognised page could not be converted",
            CODE_FAILED: "Transcoda could not process this page",
        }
        raise InferenceError(
            code, messages.get(code, "Transcoda could not process this page")
        )
