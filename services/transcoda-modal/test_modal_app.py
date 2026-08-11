"""Regression tests for the Modal deployment definition."""

from __future__ import annotations

import os
import runpy
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class ModalDefinitionTest(unittest.TestCase):
    def test_remote_import_uses_baked_digest_without_checkout_files(self) -> None:
        source = Path(__file__).with_name("modal_app.py")
        digest = "sha256:" + "a" * 64

        with tempfile.TemporaryDirectory() as directory:
            isolated_module = Path(directory) / "modal_app.py"
            shutil.copyfile(source, isolated_module)
            with patch.dict(
                os.environ,
                {
                    "OTS_SOURCE_COMMIT": "b" * 40,
                    "TRANSCODA_CONTAINER_IMAGE_DIGEST": digest,
                },
                clear=False,
            ):
                values = runpy.run_path(str(isolated_module))

        self.assertEqual(values["CONTAINER_IMAGE_DIGEST"], digest)
        self.assertEqual(values["SOURCE_COMMIT"], "b" * 40)


if __name__ == "__main__":
    unittest.main()
