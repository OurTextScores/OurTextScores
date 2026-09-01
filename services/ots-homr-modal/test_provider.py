import hashlib
import unittest

from fastapi.testclient import TestClient
from ots_homr_provider import create_provider_app


class FakeEngine:
    def __init__(self):
        self.ready = False
        self.calls = []

    def warm_up(self):
        self.ready = True

    def is_ready(self):
        return self.ready

    def shutdown(self):
        self.ready = False

    def transcribe(self, page, content_type, detect_title, detector, heads):
        self.calls.append((page, content_type, detect_title, detector, heads))
        return {
            "musicxml": b'<score-partwise version="4.0"><part-list/><part id="P1"><measure number="1"/></part></score-partwise>',
            "review": {"staves": []},
        }

    def regenerate(self, staffs, title=""):
        return b'<score-partwise version="4.0"><part-list/><part id="P1"><measure number="1"/></part></score-partwise>'

    def identity(self, detector, heads):
        value = {
            "core": {
                "repository": "jhlusko/OTS-homr",
                "revision": "core",
                "sha256": "a" * 64,
            },
            "executionProvider": "CUDAExecutionProvider",
        }
        if detector != "none":
            value["textDetector"] = {
                "id": detector,
                "revision": "detector",
                "sha256": "b" * 64,
            }
        if heads != "off":
            value["structuredHeads"] = {
                "mode": heads,
                "revision": "heads",
                "sha256": "c" * 64,
                "manifestSha256": "d" * 64,
                "compatibleCoreRevision": "core",
                "emittedHeadFamilies": [],
            }
        return value

    def capabilities_identity(self):
        return {
            **self.identity("none", "off"),
            "textDetectors": [
                {"id": "lyrics", "revision": "detector", "sha256": "b" * 64},
                {"id": "non-lyric-text", "revision": "detector", "sha256": "b" * 64},
            ],
        }


class TimeoutEngine(FakeEngine):
    def transcribe(self, page, content_type, detect_title, detector, heads):
        error = RuntimeError("private provider detail")
        error.code = "inference_timeout"
        raise error


class WarmFailureEngine(FakeEngine):
    def warm_up(self):
        raise RuntimeError("diagnostic warm-up detail")


class ProviderTest(unittest.TestCase):
    def test_readiness_logs_warm_up_failure_without_returning_detail(self):
        with self.assertLogs("ots_homr_provider", level="ERROR") as captured:
            with TestClient(
                create_provider_app(
                    engine=WarmFailureEngine(), service_revision="service"
                )
            ) as client:
                response = client.get("/readyz")

        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["ready"])
        self.assertNotIn("diagnostic warm-up detail", response.text)
        self.assertTrue(
            any("warm-up failed" in message for message in captured.output),
            captured.output,
        )

    def test_authenticated_scan_preserves_policy_and_digests(self):
        engine = FakeEngine()
        with TestClient(
            create_provider_app(
                engine=engine, service_revision="service", provider_token="secret"
            )
        ) as client:
            page = b"\x89PNG\r\n\x1a\npage"
            response = client.post(
                "/v1/scan-page",
                headers={"Authorization": "Bearer secret", "Idempotency-Key": "e" * 64},
                files={"page": ("page.png", page, "image/png")},
                data={
                    "detectTitle": "true",
                    "textDetector": "lyrics",
                    "structuredHeadsMode": "review-only",
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["inputSha256"], hashlib.sha256(page).hexdigest())
            self.assertEqual(body["engine"]["textDetector"]["id"], "lyrics")
            self.assertEqual(body["review"], {"staves": []})
            self.assertEqual(engine.calls[0][2:], (True, "lyrics", "review-only"))
            replay = client.post(
                "/v1/scan-page",
                headers={"Authorization": "Bearer secret", "Idempotency-Key": "e" * 64},
                files={"page": ("page.png", page, "image/png")},
                data={
                    "detectTitle": "true",
                    "textDetector": "lyrics",
                    "structuredHeadsMode": "review-only",
                },
            )
            self.assertEqual(replay.json()["requestId"], body["requestId"])
            self.assertEqual(len(engine.calls), 1)

            regenerated = client.post(
                "/v1/regenerate",
                headers={"Authorization": "Bearer secret"},
                json={
                    "staffs": [
                        [["note_4", "C4", "_", "_", "_", "upper"]]
                    ]
                },
            )
            self.assertEqual(regenerated.status_code, 200, regenerated.text)
            self.assertIn("musicXmlBase64", regenerated.json()["result"])

            changed_policy = client.post(
                "/v1/scan-page",
                headers={
                    "Authorization": "Bearer secret",
                    "Idempotency-Key": "e" * 64,
                },
                files={"page": ("page.png", page, "image/png")},
                data={
                    "detectTitle": "true",
                    "textDetector": "non-lyric-text",
                    "structuredHeadsMode": "review-only",
                },
            )
            self.assertEqual(changed_policy.status_code, 400)
            self.assertEqual(changed_policy.json()["error"]["code"], "invalid_option")

    def test_rejects_invalid_policy(self):
        with TestClient(
            create_provider_app(engine=FakeEngine(), service_revision="service")
        ) as client:
            response = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "e" * 64},
                files={"page": ("page.png", b"x", "image/png")},
                data={"textDetector": "moving-main"},
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error"]["code"], "invalid_option")

    def test_rejects_image_bytes_that_do_not_match_content_type(self):
        with TestClient(
            create_provider_app(engine=FakeEngine(), service_revision="service")
        ) as client:
            response = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "e" * 64},
                files={"page": ("page.png", b"not a png", "image/png")},
            )
            self.assertEqual(response.status_code, 415)
            self.assertEqual(response.json()["error"]["code"], "invalid_media_type")

    def test_capabilities_include_every_detector_identity(self):
        with TestClient(
            create_provider_app(
                engine=FakeEngine(),
                service_revision="service",
                provider_source_commit="f" * 40,
            )
        ) as client:
            body = client.get("/v1/capabilities").json()
            self.assertEqual(
                [detector["id"] for detector in body["textDetectors"]],
                ["lyrics", "non-lyric-text"],
            )
            self.assertEqual(
                body["textDetectorOptions"], ["lyrics", "non-lyric-text", "none"]
            )
            self.assertEqual(body["providerSourceCommit"], "f" * 40)
            self.assertIn("/services/ots-homr-modal", body["providerSource"])

    def test_maps_classified_timeout_without_leaking_detail(self):
        with TestClient(
            create_provider_app(engine=TimeoutEngine(), service_revision="service")
        ) as client:
            response = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "e" * 64},
                files={
                    "page": (
                        "page.png",
                        b"\x89PNG\r\n\x1a\npage",
                        "image/png",
                    )
                },
            )
            self.assertEqual(response.status_code, 504)
            self.assertEqual(response.json()["error"]["code"], "inference_timeout")
            self.assertNotIn("private provider detail", response.text)


if __name__ == "__main__":
    unittest.main()
