import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from homr_core import MODEL_NAME, PatchedHomrCore, install_runtime_artifacts


class FakeHomrEngine:
    instances = []

    def __init__(self, **options):
        self.options = options
        self.calls = []
        self.ready = False
        self.instances.append(self)

    def warm_up(self):
        self.ready = True

    def is_ready(self):
        return self.ready

    def transcribe(self, page, suffix, detect_title):
        self.calls.append((page, suffix, detect_title))
        kind = b"heads" if self.options["structured_heads_path"] else b"plain"
        return {"musicxml": kind}

    def shutdown(self):
        self.ready = False


class HomrCoreTest(unittest.TestCase):
    def setUp(self):
        FakeHomrEngine.instances = []

    def artifacts(self, root):
        source = root / "source"
        source.mkdir()
        encoder, decoder, heads = (
            source / name for name in ("encoder.onnx", "decoder.onnx", "heads.onnx")
        )
        for path in (encoder, decoder, heads):
            path.write_bytes(path.name.encode())
        return SimpleNamespace(encoder=encoder, decoder=decoder, heads=heads)

    def test_installs_all_graphs_under_patched_homr_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            install_runtime_artifacts(self.artifacts(root), homr_root=root / "homr")
            target = root / "homr" / "homr" / "transformer"
            self.assertEqual(
                (target / f"encoder_{MODEL_NAME}_fp16.onnx").read_bytes(),
                b"encoder.onnx",
            )
            self.assertEqual(
                (target / f"decoder_{MODEL_NAME}_fp16.onnx").read_bytes(),
                b"decoder.onnx",
            )
            self.assertEqual(
                (target / f"structured_heads_{MODEL_NAME}.onnx").read_bytes(),
                b"heads.onnx",
            )
            self.assertFalse((target / f"encoder_{MODEL_NAME}_fp16.onnx").is_symlink())
            self.assertFalse((target / f"decoder_{MODEL_NAME}_fp16.onnx").is_symlink())
            self.assertFalse(
                (target / f"structured_heads_{MODEL_NAME}.onnx").is_symlink()
            )
            self.assertEqual(os.environ["HOMR_MODEL_NAME"], MODEL_NAME)

    def test_routes_each_head_mode_without_unnecessary_core_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = PatchedHomrCore(
                artifacts=self.artifacts(root),
                homr_root=root / "homr",
                engine_factory=FakeHomrEngine,
            )
            plain, heads = FakeHomrEngine.instances
            core.warm_up()
            self.assertTrue(core.is_ready())

            self.assertEqual(
                core.transcribe(b"off", "image/png", False, "off"), b"plain"
            )
            self.assertEqual(
                core.transcribe(b"review", "image/jpeg", True, "review-only"), b"plain"
            )
            self.assertEqual(
                core.transcribe(
                    b"experimental", "image/png", False, "experimental-output"
                ),
                b"heads",
            )
            self.assertEqual([call[0] for call in plain.calls], [b"off", b"review"])
            self.assertEqual(
                [call[0] for call in heads.calls], [b"review", b"experimental"]
            )


if __name__ == "__main__":
    unittest.main()
