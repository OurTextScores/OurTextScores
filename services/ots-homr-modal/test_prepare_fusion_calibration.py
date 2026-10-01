import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image
from prepare_fusion_calibration import normalize_box, partition, prepare, pixel_identity


class PreparationTest(unittest.TestCase):
    def test_oversized_scan_is_deferred_before_raster_allocation(self):
        image = MagicMock()
        image.size = (20_000, 20_000)
        image.__enter__.return_value = image
        original_limit = Image.MAX_IMAGE_PIXELS
        with patch('prepare_fusion_calibration.Image.open', return_value=image):
            with self.assertRaisesRegex(ValueError, 'oversized-page-deferred'):
                pixel_identity(Path('huge.png'))
        image.convert.assert_not_called()
        self.assertEqual(Image.MAX_IMAGE_PIXELS, original_limit)

    def test_score_assignment_is_stable_and_invalid_geometry_is_not_clamped(self):
        self.assertEqual(partition('IMSLP123'), partition('IMSLP123'))
        with self.assertRaises(ValueError):
            normalize_box(dict(left=-1, top=0, right=10, bottom=10), 100, 100)

    def test_partial_labels_never_become_negative_truth_or_runtime_calibration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'homr-artifacts/ground_truth/ossq_boxes/sq123'
            folder.mkdir(parents=True)
            Image.new('RGB', (40, 40), 'white').save(folder / 'page.png')
            data = dict(image='page.png', lyrics=[], text_boxes={'Tempo': [dict(left=1, top=2, right=11, bottom=12)]})
            (folder / 'a.boxes.json').write_text(json.dumps(data))
            (folder / 'b.boxes.json').write_text(json.dumps(data))
            rows, stats = prepare(root, root / 'out')
            self.assertEqual(stats['score_overlap'], 0)
            self.assertEqual(len(rows), 1)
            self.assertEqual(len(rows[0]['ground_truth']), 1)
            self.assertEqual(len(rows[0]['ground_truth'][0]['evidence']), 2)
            self.assertEqual(rows[0]['ground_truth'][0]['semanticFamily'], 'DirectionText')
            self.assertEqual(rows[0]['complete_semantic_families'], ['Lyrics'])
            self.assertEqual(rows[0]['unmatched_policy'], 'unknown-until-adjudicated')
            self.assertEqual(rows[0]['detector_training_membership'], 'unverified')
            self.assertFalse((root / 'out/fusion-v1.json').exists())
            plan = json.loads((root / 'out/preparation-policy.json').read_text())
            self.assertIsNone(plan['fittedCalibrators'])
            self.assertEqual(set(plan['logicalDetectors']), {'lyrics', 'non-lyric-text', 'dynamics'})
            # A killed process can leave its last cache row incomplete.
            with (root / 'out/image-hash-cache.jsonl').open('a') as handle:
                handle.write('{"path":')
            resumed, _ = prepare(root, root / 'out')
            self.assertEqual(rows, resumed)
            for line in (root / 'out/image-hash-cache.jsonl').read_text().splitlines():
                json.loads(line)
            excluded, _ = prepare(root, root / 'excluded', ['sq123'])
            self.assertEqual(excluded, [])


if __name__ == '__main__':
    unittest.main()
