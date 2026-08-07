"""Contract tests for the shared HOMR provider app. Run inside the image.

These cover design section 14.1. They deliberately exercise the HTTP surface
rather than the handler functions, because the status codes are the contract:
OTS derives its entire retry classification from them.
"""

from __future__ import annotations

import base64
import hashlib
import os
import unittest
import zlib

from fastapi.testclient import TestClient

from homr_engine import (
    CODE_FAILED,
    CODE_NO_STAFF,
    CODE_NOT_READY,
    CODE_TIMEOUT,
    EngineProvenance,
    InferenceError,
)
from homr_provider import create_provider_app

KEY = "a" * 64
OTHER_KEY = "b" * 64


def png_bytes(payload: bytes = b"page") -> bytes:
    """A byte string with a valid PNG signature; content is irrelevant here."""
    return b"\x89PNG\r\n\x1a\n" + zlib.compress(payload)


MUSICXML = b'<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>'


class FakeEngine:
    def __init__(self) -> None:
        self.ready = True
        self.degraded_reason = ""
        self.last_error = ""
        self.calls = 0
        self.raises: InferenceError | None = None
        self.provenance = EngineProvenance(
            homr_commit="c0ffee",
            execution_provider="CPUExecutionProvider",
            available_execution_providers=["CPUExecutionProvider"],
            segmentation_model="segnet_308-abc",
            segmentation_model_sha256="11" * 32,
            transformer_model="encoder_pytorch_model_426-def.onnx",
            encoder_model_sha256="22" * 32,
            decoder_model_sha256="33" * 32,
        )

    expected_execution_provider = "CPUExecutionProvider"

    def is_ready(self) -> bool:
        return self.ready

    def warm_up(self) -> None:
        self.ready = True

    def shutdown(self) -> None:
        self.ready = False

    def transcribe(self, page: bytes, suffix: str, detect_title: bool) -> dict[str, object]:
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        return {"musicxml": MUSICXML, "durationMs": 12}


def build(engine: FakeEngine, **overrides: object) -> TestClient:
    options: dict[str, object] = dict(
        use_gpu=False,
        homr_commit="c0ffee",
        service_revision="ots-homr-test-v1",
        max_page_bytes=1024,
        hard_timeout_seconds=30,
        provider_token="test-token",
        engine_factory=lambda: engine,
    )
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
        files={"page": ("page.png", page if page is not None else png_bytes(), content_type)},
        data={"detectTitle": "false"},
    )


class ProviderContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = FakeEngine()
        self.client = build(self.engine)

    def test_requires_the_configured_bearer_token(self) -> None:
        self.assertEqual(post(self.client, token="wrong").status_code, 401)
        self.assertEqual(post(self.client, token=None).status_code, 401)

    def test_returns_provenance_and_the_v1_envelope(self) -> None:
        page = png_bytes()
        response = post(self.client, page=page)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["schemaVersion"], "ots-homr-provider.v1")
        self.assertTrue(body["requestId"])
        self.assertEqual(
            base64.b64decode(body["result"]["musicXmlBase64"]), MUSICXML
        )
        self.assertEqual(body["result"]["sha256"], hashlib.sha256(MUSICXML).hexdigest())
        self.assertEqual(body["inputSha256"], hashlib.sha256(page).hexdigest())
        engine = body["engine"]
        self.assertEqual(engine["homrCommit"], "c0ffee")
        self.assertEqual(engine["segmentationModel"], "segnet_308-abc")
        self.assertEqual(engine["segmentationModelSha256"], "11" * 32)
        self.assertEqual(engine["encoderModelSha256"], "22" * 32)
        self.assertEqual(engine["decoderModelSha256"], "33" * 32)
        self.assertEqual(engine["executionProvider"], "CPUExecutionProvider")

    def test_caches_successful_results_by_idempotency_key(self) -> None:
        page = png_bytes()
        first = post(self.client, page=page).json()
        second = post(self.client, page=page).json()
        self.assertEqual(first["requestId"], second["requestId"])
        self.assertEqual(self.engine.calls, 1)

    def test_rejects_key_reuse_for_different_input(self) -> None:
        post(self.client, page=png_bytes(b"one"))
        response = post(self.client, page=png_bytes(b"two"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_option")

    def test_transient_failure_is_not_cached(self) -> None:
        self.engine.raises = InferenceError(CODE_FAILED, "boom", detail="stack trace")
        self.assertEqual(post(self.client).status_code, 500)
        self.engine.raises = None
        self.assertEqual(post(self.client).status_code, 200)
        self.assertEqual(self.engine.calls, 2)

    def test_inference_failure_is_500_not_422(self) -> None:
        # Regression: a 4xx tells OTS the page is at fault and must not be
        # retried, which previously hid infrastructure faults as bad pages.
        self.engine.raises = InferenceError(
            CODE_FAILED, "HOMR could not process this page", detail="CUDA missing"
        )
        response = post(self.client)
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("CUDA missing", response.text)

    def test_no_staff_is_a_deterministic_422(self) -> None:
        self.engine.raises = InferenceError(CODE_NO_STAFF, "No staff lines were detected")
        response = post(self.client)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], CODE_NO_STAFF)

    def test_timeout_is_504(self) -> None:
        self.engine.raises = InferenceError(CODE_TIMEOUT, "too slow")
        self.assertEqual(post(self.client).status_code, 504)

    def test_not_ready_is_503_and_never_reaches_the_engine(self) -> None:
        self.engine.ready = False
        response = post(self.client)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], CODE_NOT_READY)
        self.assertEqual(self.engine.calls, 0)

    def test_a_timeout_kill_does_not_wedge_the_provider(self) -> None:
        # The supervisor replaces a killed child, but the replacement is cold.
        # A 503 must trigger re-warming so the caller's retry can succeed rather
        # than the provider staying unready until an operator restarts it.
        with build(self.engine) as client:
            self.engine.raises = InferenceError(CODE_TIMEOUT, "too slow")
            self.assertEqual(post(client).status_code, 504)

            self.engine.ready = False  # as _teardown_locked leaves it
            self.engine.raises = None
            self.assertEqual(post(client).status_code, 503)

            # ensure_warm ran in the background and called warm_up.
            for _ in range(50):
                if self.engine.ready:
                    break
                client.get("/readyz")
            self.assertTrue(self.engine.ready)
            self.assertEqual(post(client, key=OTHER_KEY).status_code, 200)

    def test_busy_returns_429(self) -> None:
        with build(self.engine) as client:
            client.app.state.busy = True
            response = post(client)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], "busy")

    def test_rejects_unsupported_media_type(self) -> None:
        response = post(self.client, content_type="image/gif")
        self.assertEqual(response.status_code, 415)

    def test_rejects_content_that_is_not_really_an_image(self) -> None:
        response = post(self.client, page=b"GIF89a not a png")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "invalid_image")

    def test_rejects_oversized_pages(self) -> None:
        # Incompressible payload so the encoded page really exceeds the limit.
        response = post(self.client, page=b"\x89PNG\r\n\x1a\n" + os.urandom(2048))
        self.assertEqual(response.status_code, 413)

    def test_rejects_malformed_idempotency_keys(self) -> None:
        self.assertEqual(post(self.client, key="short").status_code, 400)
        self.assertEqual(post(self.client, key="z" * 64).status_code, 400)

    def test_healthz_is_liveness_only(self) -> None:
        self.engine.ready = False
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_readyz_reflects_engine_readiness(self) -> None:
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        self.engine.ready = False
        response = self.client.get("/readyz")
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["ready"])

    def test_capabilities_discloses_source_and_licence(self) -> None:
        body = self.client.get("/v1/capabilities").json()
        self.assertEqual(body["providerLicense"], "AGPL-3.0-or-later")
        self.assertEqual(body["homrLicense"], "AGPL-3.0")
        self.assertIn("c0ffee", body["source"])
        self.assertEqual(body["segmentationModelSha256"], "11" * 32)
        self.assertEqual(body["hardTimeoutSeconds"], 30)

    def test_token_is_optional_when_unset(self) -> None:
        client = build(FakeEngine(), provider_token="")
        self.assertEqual(post(client, token=None).status_code, 200)


if __name__ == "__main__":
    unittest.main()
