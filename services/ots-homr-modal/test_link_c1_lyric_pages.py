import json
import tempfile
import unittest
from pathlib import Path

from link_c1_lyric_pages import check_systems, run, system_for_measure
from prepare_c1_lyric_references import sha


def system(index, start, end):
    return {
        "system_index": index,
        "start_measure": start,
        "end_measure": end,
        "status": "aligned",
        "boundary_certified": True,
        "count_exact": True,
    }


class PageLinkTest(unittest.TestCase):
    def test_zero_based_exclusive_native_windows_assign_physical_boundaries_once(self):
        rows = [system(0, 0, 3), system(1, 3, 7)]
        self.assertEqual(system_for_measure(rows, 1), 0)
        self.assertEqual(system_for_measure(rows, 3), 0)
        self.assertEqual(system_for_measure(rows, 4), 1)
        self.assertEqual(system_for_measure(rows, 7), 1)
        with self.assertRaises(ValueError):
            system_for_measure(rows, 0)

    def test_incomplete_ambiguous_or_gapped_pages_fail(self):
        for rows in (
            [system(1, 0, 3)],
            [system(0, 0, 3), system(1, 4, 7)],
            [{**system(0, 0, 3), "boundary_certified": False}],
        ):
            with self.assertRaises(ValueError):
                check_systems(rows)
        with self.assertRaises(ValueError):
            system_for_measure([system(0, 0, 3), system(1, 2, 4)], 3)

    def test_test_partition_is_rejected_before_image_or_native_read(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            page = {"id": "x", "partition": "test"}
            selection = root / "selection.json"
            selection.write_text(json.dumps([{"page": page}]))
            review = root / "review.json"
            review.write_text(
                json.dumps(
                    {
                        "selection_sha256": sha(selection),
                        "reviewer": "test",
                        "model_predictions_used": False,
                        "OCR_text_used": False,
                    }
                )
            )
            calibration = root / "calibration.jsonl"
            calibration.write_text(json.dumps(page) + "\n")
            alignment = root / "alignment.json"
            alignment.write_text(json.dumps({"model_predictions_used": False}))
            refs = root / "refs.jsonl"
            refs.write_text("")
            audit = root / "audit.json"
            audit.write_text("{}")
            with self.assertRaisesRegex(ValueError, "unchanged calibration"):
                run(
                    selection, review, calibration, alignment, refs, audit, root / "out"
                )
            self.assertFalse((root / "out").exists())


if __name__ == "__main__":
    unittest.main()
