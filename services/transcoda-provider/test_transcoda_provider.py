"""HTTP and conversion contract tests for the Transcoda provider."""

from __future__ import annotations

import base64
import hashlib
import os
import time
import unittest
import zlib

from fastapi.testclient import TestClient
from transcoda_engine import (
    CODE_FAILED,
    CODE_GENERATION_FAILED,
    CODE_TIMEOUT,
    EngineProvenance,
    InferenceError,
    strip_musicxml_doctype,
)
from transcoda_provider import create_provider_app

KEY = "a" * 64
OTHER_KEY = "b" * 64
MODEL_SHA256 = "3ce7387b94776cd0edc4e5b70fbc2e28ac0f4c812d5f978d1ef26e236dccdafc"
ENCODER_SHA256 = "b33653bb8c060f6dee6438f18c559dcf3258bf86cc906490daaca89bc0c39fb7"
CONTAINER_DIGEST = "sha256:" + ("c" * 64)
KERN = b"**kern\n*clefG2\n4c\n*-\n"
MUSICXML = b'<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>'


def png_bytes(payload: bytes = b"page") -> bytes:
    return b"\x89PNG\r\n\x1a\n" + zlib.compress(payload)


class FakeEngine:
    expected_execution_provider = "torch.cuda"

    def __init__(self) -> None:
        self.ready = True
        self.last_error = ""
        self.calls = 0
        self.raises: InferenceError | None = None
        self.warms = True
        self.warm_delay = 0.0
        self.provenance = EngineProvenance(
            model_artifact="btrkeks/transcoda-59M-zeroshot-v1",
            model_revision="b529f8aa5d996d9224df3395b5b92d0867343c91",
            model_artifact_sha256=MODEL_SHA256,
            transcoda_commit="82041ceec62352a040d068e1a279688cf13bb237",
            execution_provider="torch.cuda",
            available_execution_providers=["torch.cuda", "torch.cpu"],
            accelerator="NVIDIA L4",
            converter="music21",
            converter_version="9.9.1",
            encoder_artifact="facebook/convnextv2-tiny-22k-224",
            encoder_revision="9cba4896e97bb86b1eb609e482a2149d84f345bc",
            encoder_artifact_sha256=ENCODER_SHA256,
        )

    def is_ready(self) -> bool:
        return self.ready

    def warm_up(self) -> None:
        if self.warm_delay:
            time.sleep(self.warm_delay)
        if self.warms:
            self.ready = True

    def shutdown(self) -> None:
        self.ready = False

    def transcribe(self, page: bytes) -> dict[str, object]:
        self.calls += 1
        if self.raises:
            raise self.raises
        return {
            "kern": KERN,
            "musicxml": MUSICXML,
            "durationMs": 17,
            "generation": {
                "hitMaxLength": False,
                "sawEos": True,
                "truncated": False,
                "maxLength": 2048,
                "numBeams": 3,
            },
        }


def build(engine: FakeEngine, **overrides: object) -> TestClient:
    options: dict[str, object] = {
        "use_gpu": True,
        "checkpoint_path": "/opt/transcoda/transcoda-59M-zeroshot-v1.ckpt",
        "model_artifact": "btrkeks/transcoda-59M-zeroshot-v1",
        "model_revision": "b529f8aa5d996d9224df3395b5b92d0867343c91",
        "model_artifact_sha256": MODEL_SHA256,
        "transcoda_commit": "82041ceec62352a040d068e1a279688cf13bb237",
        "encoder_artifact": "facebook/convnextv2-tiny-22k-224",
        "encoder_revision": "9cba4896e97bb86b1eb609e482a2149d84f345bc",
        "encoder_artifact_sha256": ENCODER_SHA256,
        "encoder_path": "/opt/transcoda-encoder",
        "service_revision": "ots-transcoda-modal-v1",
        "container_image_digest": CONTAINER_DIGEST,
        "converter": "music21",
        "converter_version": "9.7.1",
        "max_page_bytes": 1024,
        "hard_timeout_seconds": 400,
        "provider_token": "test-token",
        "engine_factory": lambda: engine,
    }
    options.update(overrides)
    return TestClient(create_provider_app(**options))  # type: ignore[arg-type]


def post(
    client: TestClient,
    *,
    page: bytes | None = None,
    key: str = KEY,
    token: str | None = "test-token",
    content_type: str = "image/png",
):
    headers = {"Idempotency-Key": key}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return client.post(
        "/v1/scan-page",
        headers=headers,
        files={
            "page": (
                "page.png",
                page if page is not None else png_bytes(),
                content_type,
            )
        },
    )


class ProviderContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = FakeEngine()
        self.client = build(self.engine)

    def test_returns_the_fixed_envelope_and_runtime_provenance(self) -> None:
        page = png_bytes()
        response = post(self.client, page=page)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["schemaVersion"], "ots-transcoda-provider.v1")
        self.assertEqual(body["inputSha256"], hashlib.sha256(page).hexdigest())
        self.assertEqual(base64.b64decode(body["result"]["kernBase64"]), KERN)
        self.assertEqual(base64.b64decode(body["result"]["musicXmlBase64"]), MUSICXML)
        self.assertEqual(body["result"]["kernSha256"], hashlib.sha256(KERN).hexdigest())
        self.assertEqual(
            body["result"]["musicXmlSha256"], hashlib.sha256(MUSICXML).hexdigest()
        )
        self.assertEqual(body["engine"]["modelArtifactSha256"], MODEL_SHA256)
        self.assertEqual(body["engine"]["encoderArtifactSha256"], ENCODER_SHA256)
        self.assertEqual(body["engine"]["containerImageDigest"], CONTAINER_DIGEST)
        self.assertEqual(body["engine"]["executionProvider"], "torch.cuda")
        self.assertEqual(body["engine"]["converter"], "music21")
        self.assertEqual(body["engine"]["converterVersion"], "9.9.1")
        self.assertEqual(body["timing"]["inferenceMs"], 17)
        self.assertFalse(body["result"]["generation"]["truncated"])

    def test_caches_success_by_key_and_binds_it_to_input(self) -> None:
        first = post(self.client).json()
        second = post(self.client).json()
        self.assertEqual(first["requestId"], second["requestId"])
        self.assertEqual(self.engine.calls, 1)
        mismatch = post(self.client, page=png_bytes(b"different"))
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(mismatch.json()["error"]["code"], "invalid_option")

    def test_does_not_cache_transient_failures(self) -> None:
        self.engine.raises = InferenceError(CODE_FAILED, "failed", "private stack")
        self.assertEqual(post(self.client).status_code, 500)
        self.assertNotIn("private stack", post(self.client).text)
        self.engine.raises = None
        self.assertEqual(post(self.client).status_code, 200)

    def test_preserves_error_taxonomy(self) -> None:
        for error, status in (
            (InferenceError(CODE_TIMEOUT, "too slow"), 504),
            (InferenceError(CODE_GENERATION_FAILED, "bad conversion"), 422),
        ):
            self.engine.raises = error
            self.assertEqual(post(self.client, key=OTHER_KEY).status_code, status)

    def test_waits_for_cold_start_and_fails_fast_on_broken_warmup(self) -> None:
        cold = FakeEngine()
        cold.ready = False
        cold.warm_delay = 0.2
        with build(cold, ready_wait_seconds=5) as client:
            self.assertEqual(post(client).status_code, 200)

        broken = FakeEngine()
        broken.ready = False
        broken.warms = False
        started = time.monotonic()
        with build(broken, ready_wait_seconds=5) as client:
            response = post(client)
        self.assertEqual(response.status_code, 503)
        self.assertLess(time.monotonic() - started, 3)

    def test_validates_auth_media_magic_size_and_key(self) -> None:
        self.assertEqual(post(self.client, token=None).status_code, 401)
        self.assertEqual(post(self.client, content_type="image/gif").status_code, 415)
        self.assertEqual(post(self.client, page=b"not a png").status_code, 422)
        self.assertEqual(
            post(self.client, page=b"\x89PNG\r\n\x1a\n" + os.urandom(2048)).status_code,
            413,
        )
        self.assertEqual(post(self.client, key="short").status_code, 400)

    def test_health_readiness_and_capabilities_are_distinct(self) -> None:
        self.assertEqual(self.client.get("/healthz").status_code, 200)
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        capabilities = self.client.get("/v1/capabilities").json()
        self.assertEqual(capabilities["providerLicense"], "AGPL-3.0-or-later")
        self.assertEqual(capabilities["transcodaLicense"], "AGPL-3.0-only")
        self.assertEqual(capabilities["modelLicense"], "CC-BY-4.0")
        self.assertEqual(capabilities["decoding"]["numBeams"], 3)
        self.assertIn("82041ce", capabilities["upstreamSource"])
        self.engine.ready = False
        self.assertEqual(self.client.get("/readyz").status_code, 503)

    def test_refuses_unpinned_provider_identity_at_startup(self) -> None:
        with self.assertRaises(ValueError):
            build(FakeEngine(), model_artifact_sha256="not-a-sha256")
        with self.assertRaises(ValueError):
            build(FakeEngine(), encoder_artifact_sha256="not-a-sha256")
        with self.assertRaises(ValueError):
            build(FakeEngine(), container_image_digest="sha256:short")
        with self.assertRaises(ValueError):
            build(FakeEngine(), converter="another-converter")


class DoctypeTest(unittest.TestCase):
    def test_removes_music21s_external_doctype(self) -> None:
        document = (
            b'<?xml version="1.0"?>\n'
            b'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
            b'"http://www.musicxml.org/dtds/partwise.dtd">\n' + MUSICXML
        )
        stripped = strip_musicxml_doctype(document)
        self.assertNotIn(b"DOCTYPE", stripped)
        self.assertIn(b"<score-partwise", stripped)

    def test_refuses_internal_subsets_entities_and_multiple_doctypes(self) -> None:
        for document in (
            b"<!DOCTYPE score-partwise [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><score-partwise/>",
            b"<!ENTITY x 'value'><score-partwise/>",
            b"<!DOCTYPE score-partwise><!DOCTYPE score-partwise><score-partwise/>",
        ):
            with self.assertRaises(ValueError):
                strip_musicxml_doctype(document)


if __name__ == "__main__":
    unittest.main()
