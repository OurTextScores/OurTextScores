import unittest

from sweep_fusion_components import summarize


def box(label, geometry):
    return dict(
        label=label,
        confidence=0.9,
        **dict(zip(("left", "top", "right", "bottom"), geometry))
    )


class SweepTest(unittest.TestCase):
    def test_partial_unmatched_directions_stay_unknown(self):
        page = {
            "ground_truth": [
                {"semanticFamily": "DirectionText", "box": [0, 0, 10, 10]}
            ],
            "complete_semantic_families": ["Lyrics"],
        }
        result = summarize(
            page,
            {
                "lyrics": [box("Lyrics", [20, 20, 30, 30])],
                "non-lyric-text": [
                    box("Tempo", [0, 0, 10, 10]),
                    box("Tempo", [50, 50, 60, 60]),
                ],
            },
        )
        self.assertEqual(result["non-lyric-text"]["known_positive_hits"]["0.5"], 1)
        self.assertIsNone(result["non-lyric-text"]["verified_negative_candidates"])
        self.assertEqual(result["lyrics"]["verified_negative_candidates"], 1)

    def test_shared_physical_dynamic_has_one_owner_and_recall_is_not_precision(self):
        page = {
            "ground_truth": [{"semanticFamily": "Dynamic", "box": [0, 0, 10, 10]}],
            "complete_semantic_families": [],
        }
        result = summarize(
            page,
            {
                "lyrics": [],
                "non-lyric-text": [
                    box("Dynamic", [0, 0, 10, 10]),
                    box("Dynamic", [0, 0, 10, 10]),
                ],
            },
        )
        self.assertEqual(result["non-lyric-text"]["candidates"], 0)
        self.assertEqual(result["dynamics"]["candidates"], 2)
        self.assertEqual(result["dynamics"]["known_positive_hits"]["0.5"], 1)
        self.assertIsNone(result["dynamics"]["verified_negative_candidates"])


if __name__ == "__main__":
    unittest.main()
