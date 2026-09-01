import unittest
from types import SimpleNamespace

from ots_engine import OtsHomrEngine
from pins import (
    CORE_ARTIFACT_SHA256,
    CORE_REVISION,
    CORE_SHA256,
    DETECTORS,
    HEADS_CHECKPOINT_SHA256,
    HEADS_ONNX_SHA256,
    HEADS_REVISION,
)


class FakeDetector:
    def __init__(self, revision, sha256):
        self.revision = revision
        self.sha256 = sha256
        self.calls = []

    def detect(self, page):
        self.calls.append(page)


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

    def transcribe(self, page, content_type, detect_title, head_mode):
        self.calls.append((page, content_type, detect_title, head_mode))
        return {"musicxml": b"<score-partwise/>", "review": {"staves": []}}

    def regenerate(self, staffs, title=""):
        return b"<score-partwise/>"

    def shutdown(self):
        self.ready = False


class OtsHomrEngineTest(unittest.TestCase):
    def make_engine(self):
        detectors = {
            detector_id: FakeDetector(revision, digest)
            for detector_id, (_repo, revision, _filename, digest) in DETECTORS.items()
        }
        core = FakeCore()
        artifacts = SimpleNamespace(detectors=detectors)
        return OtsHomrEngine(artifacts=artifacts, core=core), detectors, core

    def test_selected_detector_runs_before_core_and_none_skips_it(self):
        engine, detectors, core = self.make_engine()
        engine.warm_up()
        engine.warm_up()
        self.assertEqual(core.warm_calls, 1)
        result = engine.transcribe(
            b"lyrics-page", "image/png", True, "lyrics", "review-only"
        )
        self.assertEqual(result["musicxml"], b"<score-partwise/>")
        self.assertEqual(detectors["lyrics"].calls, [b"lyrics-page"])
        self.assertEqual(detectors["non-lyric-text"].calls, [])

        self.assertEqual(engine.regenerate([[['note_4', 'C4', '_', '_', '_', 'upper']]]), b"<score-partwise/>")
        self.assertEqual(core.calls[-1][-1], "review-only")

        engine.transcribe(b"plain-page", "image/jpeg", False, "none", "off")
        self.assertEqual(detectors["lyrics"].calls, [b"lyrics-page"])
        self.assertEqual(detectors["non-lyric-text"].calls, [])

    def test_identity_and_capabilities_use_release_checkpoint_pins(self):
        engine, _detectors, _core = self.make_engine()
        identity = engine.identity("non-lyric-text", "experimental-output")
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
            ["lyrics", "non-lyric-text"],
        )
        self.assertEqual(capabilities["structuredHeads"]["revision"], HEADS_REVISION)

    def test_rejects_cpu_execution_provider_during_warmup(self):
        engine, _detectors, _core = self.make_engine()
        engine.execution_provider = "CPUExecutionProvider"
        with self.assertRaisesRegex(RuntimeError, "requires CUDA"):
            engine.warm_up()


if __name__ == "__main__":
    unittest.main()
