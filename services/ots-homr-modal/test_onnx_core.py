import unittest
from unittest.mock import patch

from onnx_core import CoreLoadError, load_rare_num_sessions


class OnnxCoreTest(unittest.TestCase):
    @patch("onnx_core.require_artifact")
    def test_refuses_without_cuda_before_opening_sessions(self, _artifact):
        class Ort:
            @staticmethod
            def get_available_providers():
                return ["CPUExecutionProvider"]
        with patch.dict("sys.modules", {"onnxruntime": Ort}):
            with self.assertRaises(CoreLoadError):
                load_rare_num_sessions(encoder=__import__("pathlib").Path("encoder"), decoder=__import__("pathlib").Path("decoder"), heads=__import__("pathlib").Path("heads"), encoder_sha256="a" * 64, decoder_sha256="b" * 64, heads_sha256="c" * 64)


if __name__ == "__main__":
    unittest.main()
