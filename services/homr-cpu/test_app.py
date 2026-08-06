"""Contract tests that run inside the CPU provider image."""

from __future__ import annotations

import hashlib
import io
import unittest
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

import app as provider


def upload(contents: bytes) -> UploadFile:
    return UploadFile(
        file=io.BytesIO(contents),
        filename="page.png",
        headers=Headers({"content-type": "image/png"}),
    )


class ProviderContractTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        provider.PROVIDER_TOKEN = "test-token"
        provider.inference_busy = False
        provider.result_cache.clear()

    async def test_requires_the_configured_bearer_token(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            await provider.scan_page(
                page=upload(b"image"),
                detectTitle=False,
                idempotency_key="a" * 64,
                authorization="Bearer wrong",
            )
        self.assertEqual(raised.exception.status_code, 401)

    async def test_returns_verified_cpu_provenance_and_caches_by_idempotency_key(self) -> None:
        contents = b"image"
        music_xml = b"<score-partwise><part-list/></score-partwise>"
        with patch.object(provider, "transcribe", return_value=music_xml) as transcribe:
            first = await provider.scan_page(
                page=upload(contents),
                detectTitle=False,
                idempotency_key="b" * 64,
                authorization="Bearer test-token",
            )
            second = await provider.scan_page(
                page=upload(contents),
                detectTitle=False,
                idempotency_key="b" * 64,
                authorization="Bearer test-token",
            )

        self.assertEqual(first, second)
        self.assertEqual(transcribe.call_count, 1)
        self.assertEqual(first["executionProvider"], "CPUExecutionProvider")
        self.assertEqual(first["inputSha256"], hashlib.sha256(contents).hexdigest())
        self.assertEqual(first["homrRevision"], provider.HOMR_COMMIT)

    async def test_rejects_idempotency_key_reuse_for_different_input(self) -> None:
        music_xml = b"<score-partwise><part-list/></score-partwise>"
        with patch.object(provider, "transcribe", return_value=music_xml):
            await provider.scan_page(
                page=upload(b"first image"),
                detectTitle=False,
                idempotency_key="d" * 64,
                authorization="Bearer test-token",
            )
            with self.assertRaises(HTTPException) as raised:
                await provider.scan_page(
                    page=upload(b"different image"),
                    detectTitle=False,
                    idempotency_key="d" * 64,
                    authorization="Bearer test-token",
                )
        self.assertEqual(raised.exception.status_code, 409)

    async def test_rejects_invalid_operation_keys_before_inference(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            await provider.scan_page(
                page=upload(b"image"),
                detectTitle=False,
                idempotency_key="not-a-key",
                authorization="Bearer test-token",
            )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_returns_capacity_instead_of_queuing_parallel_inference(self) -> None:
        provider.inference_busy = True
        try:
            with self.assertRaises(HTTPException) as raised:
                await provider.scan_page(
                    page=upload(b"image"),
                    detectTitle=False,
                    idempotency_key="c" * 64,
                    authorization="Bearer test-token",
                )
        finally:
            provider.inference_busy = False
        self.assertEqual(raised.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
