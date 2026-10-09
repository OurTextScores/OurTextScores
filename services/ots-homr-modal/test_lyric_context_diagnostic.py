import unittest

from lyric_context_diagnostic import direction_context


class Gate:
    def classify(self, text):
        direction = "tempo" in text
        return {
            "prediction": "DirectionText" if direction else "Lyrics",
            "score": 0.05 if direction else 0.8,
            "proposedLyric": not direction,
        }


class ContextTest(unittest.TestCase):
    def test_recovers_overlapping_fragmented_direction(self):
        row = {"text": "a", "box": [1099, 1769, 1131, 1797], "proposedLyric": True}
        full = [
            {
                "text": "tempo",
                "box": [[1117, 1759], [1237, 1762], [1235, 1807], [1116, 1804]],
            }
        ]
        self.assertEqual(
            direction_context(row, full, Gate())["combinedText"], "a tempo"
        )

    def test_preserves_short_lyrics_without_direction_context(self):
        for text in ["a", "fi", "her", "be", "sé", "Ω"]:
            with self.subTest(text=text):
                row = {"text": text, "box": [0, 100, 30, 130], "proposedLyric": True}
                self.assertIsNone(
                    direction_context(
                        row, [{"text": "love", "box": [30, 100, 80, 130]}], Gate()
                    )
                )

    def test_does_not_borrow_direction_from_another_line(self):
        row = {"text": "a", "box": [0, 100, 30, 130], "proposedLyric": True}
        self.assertIsNone(
            direction_context(row, [{"text": "tempo", "box": [0, 60, 100, 95]}], Gate())
        )

    def test_does_not_borrow_distant_direction(self):
        row = {"text": "a", "box": [0, 100, 30, 130], "proposedLyric": True}
        self.assertIsNone(
            direction_context(
                row, [{"text": "tempo", "box": [100, 100, 180, 130]}], Gate()
            )
        )

    def test_never_turns_withheld_row_into_a_proposal(self):
        row = {"text": "a", "box": [0, 100, 30, 130], "proposedLyric": False}
        self.assertIsNone(
            direction_context(
                row, [{"text": "tempo", "box": [30, 100, 80, 130]}], Gate()
            )
        )


if __name__ == "__main__":
    unittest.main()
