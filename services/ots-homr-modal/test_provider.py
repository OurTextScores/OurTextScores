import hashlib
import unittest

from fastapi.testclient import TestClient
from ots_homr_provider import create_provider_app
from fusion_v1 import FusionResult


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

    def transcribe(self, page, content_type, detect_title, detector, score_profile=None):
        self.calls.append((page, content_type, detect_title, detector))
        core = {
            "musicxml": b'<score-partwise version="4.0"><part-list/><part id="P1"><measure number="1"/></part></score-partwise>',
            "review": {"title": "Core", "staves": []},
        }
        heads = {
            "musicxml": core["musicxml"].replace(b"Core", b"Heads"),
            "review": {
                "title": "Heads",
                "regeneration": [{
                    "tokens": [["note_4", "C4", "_", "_", "_", "upper"]],
                    "structured": [{"beamLevels": ["none"], "dynamic": "f"}],
                }],
                "staves": [{
                    "index": 0,
                    "tokens": [["note_4", "C4", "_", "_", "_", "upper"]],
                    "structured": [{"beamLevels": ["none"], "dynamic": "f"}],
                    "symbols": [],
                }],
            },
        }
        return {"core": core, "additional-heads": heads}

    def regenerate(self, staffs, title=""):
        return b'<score-partwise version="4.0"><part-list/><part id="P1"><measure number="1"/></part></score-partwise>'

    def materialize_structured(self, staffs, structured, families, title=""):
        self.calls.append(("materialize", staffs, structured, families, title))
        return b'<score-partwise version="4.0"><part-list/><part id="P1"><measure number="1"/></part></score-partwise>'

    def identity(self, detector):
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
        value["structuredHeads"] = {
            "mode": "both",
            "revision": "heads",
            "sha256": "c" * 64,
            "manifestSha256": "d" * 64,
            "compatibleCoreRevision": "core",
            "emittedHeadFamilies": [
                "beam.level", "advance.delta", "stem.direction", "tie", "slur"
            ],
        }
        return value

    def capabilities_identity(self):
        return {
            **self.identity("none"),
            "textDetectors": [
                {"id": "lyrics", "revision": "detector", "sha256": "b" * 64},
                {"id": "non-lyric-text", "revision": "detector", "sha256": "b" * 64},
            ],
        }


class TimeoutEngine(FakeEngine):
    def transcribe(self, page, content_type, detect_title, detector, score_profile=None):
        error = RuntimeError("private provider detail")
        error.code = "inference_timeout"
        raise error


class WarmFailureEngine(FakeEngine):
    def warm_up(self):
        raise RuntimeError("diagnostic warm-up detail")


class FusionEngine(FakeEngine):
    fusion_manifest = object()

    def transcribe_fusion(self, page, content_type, detect_title, score_profile=None):
        result = self.transcribe(page, content_type, detect_title, "fusion-v1", score_profile)
        result["fusion"] = FusionResult(
            regions=[],
            summary={
                "accepted": 0,
                "review": 0,
                "reviewOmitted": 0,
                "rejected": 0,
                "rejectedByReason": {},
                "rejectedByClass": {},
                "byClass": {},
            },
        )
        return result

    def identity(self, detector):
        value = super().identity("none" if detector == "fusion-v1" else detector)
        if detector == "fusion-v1":
            value["textPolicy"] = {
                "mode": "fusion-v1",
                "fusionRevision": "fusion-v1",
                "calibrationRevision": "calibration",
                "detectors": [
                    {"id": "lyrics", "revision": "lyric", "sha256": "a" * 64},
                    {"id": "non-lyric-text", "revision": "non-lyric", "sha256": "b" * 64},
                ],
            }
        return value


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
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["inputSha256"], hashlib.sha256(page).hexdigest())
            self.assertEqual(body["engine"]["textDetector"]["id"], "lyrics")
            self.assertEqual(body["schemaVersion"], "ots-ots-homr-provider.v2")
            self.assertEqual(body["result"]["selectedCandidate"], "core")
            self.assertEqual(body["result"]["candidates"]["core"]["review"]["title"], "Core")
            self.assertEqual(
                body["result"]["candidates"]["additional-heads"]["review"]["staves"][0]["structured"][0]["dynamic"],
                "f",
            )
            self.assertEqual(
                body["result"]["candidates"]["additional-heads"]["review"]["regeneration"][0]["tokens"][0][1],
                "C4",
            )
            self.assertEqual(engine.calls[0][2:], (True, "lyrics"))
            replay = client.post(
                "/v1/scan-page",
                headers={"Authorization": "Bearer secret", "Idempotency-Key": "e" * 64},
                files={"page": ("page.png", page, "image/png")},
                data={
                    "detectTitle": "true",
                    "textDetector": "lyrics",
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

            materialized = client.post(
                "/v1/materialize-structured",
                headers={"Authorization": "Bearer secret"},
                json={
                    "title": "Title",
                    "staves": [[ ["note_4", "C4", "_", "_", "_", "upper"] ]],
                    "structured": [[{"beamLevels": ["none"]}]],
                    "families": ["advance", "tie"],
                },
            )
            self.assertEqual(materialized.status_code, 200, materialized.text)
            self.assertEqual(materialized.json()["result"]["families"], ["advance", "tie"])

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

    def test_fusion_needs_explicit_mode_and_calibration_before_inference(self):
        engine = FakeEngine()
        with TestClient(create_provider_app(engine=engine, service_revision="service")) as client:
            page = b"\x89PNG\r\n\x1a\npage"
            data = {"textPolicy": '{"mode":"fusion-v1"}'}
            response = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "e" * 64},
                files={"page": ("page.png", page, "image/png")},
                data=data,
            )
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["error"]["code"], "model_not_ready")
            self.assertEqual(engine.calls, [])
            conflicting = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "f" * 64},
                files={"page": ("page.png", page, "image/png")},
                data={**data, "textDetector": "lyrics"},
            )
            self.assertEqual(conflicting.status_code, 400)

    def test_empty_fusion_runs_both_components_and_preserves_core_xml(self):
        engine = FusionEngine()
        with TestClient(create_provider_app(engine=engine, service_revision="service")) as client:
            response = client.post(
                "/v1/scan-page",
                headers={"Idempotency-Key": "e" * 64},
                files={"page": ("page.png", b"\x89PNG\r\n\x1a\npage", "image/png")},
                data={"textPolicy": '{"mode":"fusion-v1"}'},
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["result"]["fusionSummary"]["accepted"], 0)
            self.assertEqual(body["result"]["fusedRegions"], [])
            self.assertEqual(body["engine"]["textPolicy"]["mode"], "fusion-v1")
            self.assertNotIn("textDetector", body["engine"])
            self.assertEqual(len(engine.calls), 1)

    def test_fusion_preserves_classified_recognition_errors_without_private_detail(self):
        for stage, code, status, expected in [
            ("recognition", "no_staff_detected", 422, "no_staff_detected"),
            ("recognition", "generation_failed", 422, "generation_failed"),
            ("recognition", "inference_timeout", 504, "inference_timeout"),
            ("lyrics-detector", "no_staff_detected", 500, "fusion_failed"),
            ("recognition", "unknown_private_error", 500, "fusion_failed"),
        ]:
            class FailingFusionEngine(FusionEngine):
                def transcribe_fusion(self, *args, **kwargs):
                    cause = RuntimeError("private recognition detail")
                    cause.code = code
                    wrapper = RuntimeError("private wrapper detail")
                    wrapper.code = "fusion_failed"
                    wrapper.stage = stage
                    raise wrapper from cause

            with self.subTest(stage=stage, code=code), TestClient(
                create_provider_app(engine=FailingFusionEngine(), service_revision="service")
            ) as client:
                response = client.post(
                    "/v1/scan-page",
                    headers={"Idempotency-Key": "e" * 64},
                    files={"page": ("page.png", b"\x89PNG\r\n\x1a\npage", "image/png")},
                    data={"textPolicy": '{"mode":"fusion-v1"}'},
                )
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(response.json()["error"]["code"], expected)
                self.assertNotIn("private", response.text)

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
            self.assertEqual(body["outputCandidates"], ["core", "additional-heads"])
            self.assertEqual(
                body["allowedStructuredFamilies"],
                ["advance", "slur", "stem", "tie"],
            )

    def test_rejects_dynamic_as_a_materialized_family(self):
        with TestClient(
            create_provider_app(engine=FakeEngine(), service_revision="service")
        ) as client:
            response = client.post(
                "/v1/materialize-structured",
                json={"title": "", "staves": [], "structured": [], "families": ["dynamic"]},
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error"]["code"], "invalid_option")

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


class BeamsAreNotOfferedTest(unittest.TestCase):
    def test_beam_is_not_an_allowed_family(self):
        from ots_homr_provider import STRUCTURED_FAMILIES

        self.assertNotIn("beam", STRUCTURED_FAMILIES)
