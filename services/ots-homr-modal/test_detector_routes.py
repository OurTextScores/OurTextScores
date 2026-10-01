import unittest

from detector_routes import route_detections
from pins import DETECTORS, LOGICAL_DETECTORS


class DetectorRoutesTest(unittest.TestCase):
    def test_two_pinned_artifacts_supply_three_logical_routes(self):
        self.assertEqual(len(DETECTORS), 2)
        self.assertEqual(LOGICAL_DETECTORS['dynamics'], DETECTORS['non-lyric-text'])

    def test_dynamic_is_partitioned_once_without_mutating_physical_outputs(self):
        tempo, dynamic = {'label': 'Tempo'}, {'label': 'Dynamic'}
        physical = {'lyrics': [{'label': 'Lyrics'}, {'label': 'Dynamic'}],
                    'non-lyric-text': [tempo, dynamic]}
        result = route_detections(physical)
        self.assertEqual(result['non-lyric-text'], [tempo])
        self.assertEqual(result['dynamics'], [dynamic])
        self.assertEqual(physical['non-lyric-text'], [tempo, dynamic])
        # Unsupported e2 outputs are retained for an explicit gate rejection,
        # not allowed to become a second dynamics owner.
        self.assertEqual(len(result['lyrics']), 2)

    def test_absent_run_fails_and_completed_empty_runs_succeed(self):
        with self.assertRaises(ValueError):
            route_detections({'lyrics': []})
        self.assertEqual(route_detections({'lyrics': [], 'non-lyric-text': []}),
                         {'lyrics': [], 'non-lyric-text': [], 'dynamics': []})


if __name__ == '__main__':
    unittest.main()
