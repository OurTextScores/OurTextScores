import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from runtime_identity import RuntimeIdentityError, load_structured_manifest, selected_components


class RuntimeIdentityTest(unittest.TestCase):
    def test_manifest_requires_matching_training_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps({"schemaVersion": "homr.capability-manifest.v1", "trainingRevision": "997", "runtimeArtifacts": {"onnx": {"filename": "structured_heads_rareNumMixed.onnx"}}}))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(load_structured_manifest(path, expected_sha256=digest, core_training_revision="997")["trainingRevision"], "997")
            with self.assertRaises(RuntimeIdentityError):
                load_structured_manifest(path, expected_sha256=digest, core_training_revision="other")

    def test_review_only_heads_never_claim_emitted_dynamics(self):
        identity = selected_components(core_revision="core", core_sha256="a" * 64, execution_provider="CUDAExecutionProvider", text_detector="none", heads_mode="review-only", heads_revision="heads", heads_sha256="b" * 64, manifest_sha256="c" * 64)
        self.assertEqual(identity["structuredHeads"]["emittedHeadFamilies"], [])


if __name__ == "__main__":
    unittest.main()
