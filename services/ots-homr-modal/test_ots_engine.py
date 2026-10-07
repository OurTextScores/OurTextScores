import unittest
from types import SimpleNamespace

import cv2
import numpy as np

from calibration_manifest import CalibrationManifest, DetectorIdentity
from fusion_policy import CLASS_ALLOWLIST
from ots_engine import OtsHomrEngine
from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_REVISION,
    CORE_SHA256,
    DETECTORS,
    DETECTOR_ROUTES,
    LOGICAL_DETECTORS,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    HEADS_REVISION,
)


class FakeDetector:
    def __init__(self, revision, sha256):
        self.revision = revision
        self.sha256 = sha256
        self.calls = []
        self.fail = False

    def detect(self, page):
        self.calls.append(page)
        if self.fail:
            raise RuntimeError("private detector detail")
        return []


class FakeCore:
    def __init__(self):
        self.ready = False
        self.calls = []
        self.warm_calls = 0

    def warm_up(self):
        self.warm_calls += 1
        self.ready = True

    def is_ready(self):
        return self.ready

    def transcribe_both(self, page, content_type, detect_title, score_profile=None):
        self.calls.append((page, content_type, detect_title, score_profile))
        result = {"musicxml": b"<score-partwise/>", "review": {"staves": []}}
        return {"core": result, "additional-heads": result}

    def regenerate(self, staffs, title=""):
        return b"<score-partwise/>"

    def materialize_structured(self, staffs, structured, families, title=""):
        self.calls.append(("materialize", staffs, structured, families, title))
        return b"<score-partwise/>"

    def shutdown(self):
        self.ready = False


class OtsHomrEngineTest(unittest.TestCase):
    def make_engine(self):
        detectors = {
            detector_id: FakeDetector(revision, digest)
            for detector_id, (_repo, revision, _filename, digest) in DETECTORS.items()
        }
        detectors = {
            logical: detectors[source] for logical, source in DETECTOR_ROUTES.items()
        }
        core = FakeCore()
        artifacts = SimpleNamespace(detectors=detectors)
        return OtsHomrEngine(artifacts=artifacts, core=core), detectors, core

    def test_selected_detector_runs_before_core_and_none_skips_it(self):
        engine, detectors, core = self.make_engine()
        engine.warm_up()
        engine.warm_up()
        self.assertEqual(core.warm_calls, 1)
        result = engine.transcribe(b"lyrics-page", "image/png", True, "lyrics")
        self.assertEqual(result["core"]["musicxml"], b"<score-partwise/>")
        self.assertEqual(detectors["lyrics"].calls, [b"lyrics-page"])
        self.assertEqual(detectors["non-lyric-text"].calls, [])

        self.assertEqual(
            engine.regenerate([[["note_4", "C4", "_", "_", "_", "upper"]]]),
            b"<score-partwise/>",
        )
        engine.transcribe(b"plain-page", "image/jpeg", False, "none")
        self.assertEqual(detectors["lyrics"].calls, [b"lyrics-page"])
        self.assertEqual(detectors["non-lyric-text"].calls, [])

    def test_identity_and_capabilities_use_release_checkpoint_pins(self):
        engine, _detectors, _core = self.make_engine()
        identity = engine.identity("non-lyric-text")
        self.assertEqual(identity["core"]["revision"], CORE_REVISION)
        self.assertEqual(identity["core"]["sha256"], CORE_ARTIFACT_SHA256)
        self.assertEqual(
            identity["core"]["runtimeArtifacts"]["encoderOnnxSha256"],
            CORE_SHA256["encoder.onnx"],
        )
        self.assertEqual(identity["structuredHeads"]["revision"], HEADS_REVISION)
        self.assertEqual(identity["structuredHeads"]["sha256"], HEADS_CHECKPOINT_SHA256)
        self.assertEqual(
            identity["structuredHeads"]["runtimeArtifacts"]["onnxSha256"],
            HEADS_ONNX_SHA256,
        )

        capabilities = engine.capabilities_identity()
        self.assertEqual(
            [item["id"] for item in capabilities["textDetectors"]],
            ["dynamics", "lyrics", "non-lyric-text"],
        )
        self.assertEqual(capabilities["structuredHeads"]["revision"], HEADS_REVISION)
        self.assertEqual(
            capabilities["structuredHeads"]["emittedHeadFamilies"],
            ["beam.level", "advance.delta", "stem.direction", "tie", "slur"],
        )

    def test_rejects_cpu_execution_provider_during_warmup(self):
        engine, _detectors, _core = self.make_engine()
        engine.execution_provider = "CPUExecutionProvider"
        with self.assertRaisesRegex(RuntimeError, "requires CUDA"):
            engine.warm_up()

    def test_notation_policy_is_reported_only_when_enabled(self):
        engine, _detectors, core = self.make_engine()
        self.assertNotIn("notationPolicies", engine.identity("none"))
        core.notation_policy_identity = lambda: {"pairedTremoloTiming": "peer-span-v1"}
        expected = {"pairedTremoloTiming": "peer-span-v1"}
        self.assertEqual(engine.identity("none")["notationPolicies"], expected)
        self.assertEqual(engine.capabilities_identity()["notationPolicies"], expected)

    def test_fusion_runs_both_detectors_and_preserves_core_xml(self):
        engine, detectors, core = self.make_engine()
        engine.fusion_manifest = CalibrationManifest(
            policy="fusion-v1",
            policy_revision="test",
            detectors={
                detector_id: DetectorIdentity("test", revision, "test.pth", digest)
                for detector_id, (
                    _repo,
                    revision,
                    _filename,
                    digest,
                ) in LOGICAL_DETECTORS.items()
            },
            class_allowlist=CLASS_ALLOWLIST,
            calibration={},
            accept={},
            iou_threshold=0.3,
            containment_threshold=0.6,
            minimum_winner_margin=0.1,
        )
        engine.warm_up()
        ok, encoded = cv2.imencode(".png", np.full((10, 10, 3), 255, dtype=np.uint8))
        self.assertTrue(ok)
        page = encoded.tobytes()
        result = engine.transcribe_fusion(page, "image/png", False)
        self.assertEqual(result["fusion"].summary["accepted"], 0)
        self.assertEqual(result["core"]["musicxml"], b"<score-partwise/>")
        self.assertEqual(detectors["lyrics"].calls, [page])
        self.assertEqual(detectors["non-lyric-text"].calls, [page])
        self.assertEqual(len(core.calls), 1)

    def test_fusion_without_calibration_fails_before_inference(self):
        engine, detectors, core = self.make_engine()
        engine.warm_up()
        with self.assertRaisesRegex(RuntimeError, "failed at calibration"):
            engine.transcribe_fusion(b"page", "image/png", False)
        self.assertEqual(core.calls, [])
        self.assertEqual(detectors["lyrics"].calls, [])

    def test_detector_failure_does_not_fall_back_to_one_detector(self):
        engine, detectors, core = self.make_engine()
        engine.fusion_manifest = CalibrationManifest(
            policy="fusion-v1",
            policy_revision="test",
            detectors={
                detector_id: DetectorIdentity("test", revision, "test.pth", digest)
                for detector_id, (
                    _repo,
                    revision,
                    _filename,
                    digest,
                ) in LOGICAL_DETECTORS.items()
            },
            class_allowlist=CLASS_ALLOWLIST,
            calibration={},
            accept={},
            iou_threshold=0.3,
            containment_threshold=0.6,
            minimum_winner_margin=0.1,
        )
        engine.warm_up()
        ok, encoded = cv2.imencode(".png", np.full((10, 10, 3), 255, dtype=np.uint8))
        self.assertTrue(ok)
        detectors["non-lyric-text"].fail = True
        with self.assertRaisesRegex(RuntimeError, "non-lyric-text-detector"):
            engine.transcribe_fusion(encoded.tobytes(), "image/png", False)
        self.assertEqual(core.calls, [])

    def test_shared_e4_runs_once_and_dynamic_has_sole_review_ownership(self):
        engine, detectors, core = self.make_engine()
        engine.fusion_manifest = CalibrationManifest(
            policy="fusion-v1",
            policy_revision="test",
            detectors={
                k: DetectorIdentity(repo, revision, filename, digest)
                for k, (repo, revision, filename, digest) in LOGICAL_DETECTORS.items()
            },
            class_allowlist=CLASS_ALLOWLIST,
            calibration={},
            accept={},
            iou_threshold=0.3,
            containment_threshold=0.6,
            minimum_winner_margin=0.1,
        )
        dynamics = dict(
            label="Dynamic", left=0, top=0, right=5, bottom=5, confidence=0.99
        )
        detector = detectors["non-lyric-text"]
        original = detector.detect

        def detect(page):
            original(page)
            return [dynamics]

        detector.detect = detect
        engine.warm_up()
        _, encoded = cv2.imencode(".png", np.full((10, 10, 3), 255, dtype=np.uint8))
        result = engine.transcribe_fusion(encoded.tobytes(), "image/png", False)
        self.assertIs(detectors["dynamics"], detector)
        self.assertEqual(len(detector.calls), 1)
        self.assertEqual(len(core.calls), 1)
        regions = result["fusion"].regions
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["reason"], "dynamic-review-only")
        self.assertEqual(regions[0]["candidates"][0]["detectorId"], "dynamics")

    def test_missing_logical_dynamic_identity_fails_before_any_inference(self):
        engine, detectors, core = self.make_engine()
        engine.fusion_manifest = CalibrationManifest(
            policy="fusion-v1",
            policy_revision="test",
            detectors={
                k: DetectorIdentity(repo, revision, filename, digest)
                for k, (repo, revision, filename, digest) in LOGICAL_DETECTORS.items()
            },
            class_allowlist=CLASS_ALLOWLIST,
            calibration={},
            accept={},
            iou_threshold=0.3,
            containment_threshold=0.6,
            minimum_winner_margin=0.1,
        )
        del detectors["dynamics"]
        engine.warm_up()
        with self.assertRaisesRegex(RuntimeError, "dynamics-detector"):
            engine.transcribe_fusion(b"page", "image/png", False)
        self.assertEqual(detectors["lyrics"].calls, [])
        self.assertEqual(core.calls, [])

    def test_shared_route_cannot_claim_another_checkpoint_identity(self):
        engine, detectors, core = self.make_engine()
        detectors["dynamics"] = FakeDetector("another-model", "another-sha")
        engine.fusion_manifest = CalibrationManifest(
            policy="fusion-v1",
            policy_revision="test",
            detectors={
                k: DetectorIdentity("test", d.revision, "test.pth", d.sha256)
                for k, d in detectors.items()
            },
            class_allowlist=CLASS_ALLOWLIST,
            calibration={},
            accept={},
            iou_threshold=0.3,
            containment_threshold=0.6,
            minimum_winner_margin=0.1,
        )
        engine.warm_up()
        with self.assertRaisesRegex(RuntimeError, "failed at calibration"):
            engine.transcribe_fusion(b"page", "image/png", False)
        self.assertEqual(detectors["lyrics"].calls, [])
        self.assertEqual(core.calls, [])


if __name__ == "__main__":
    unittest.main()
