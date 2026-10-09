import unittest

from competing_detector_diagnostic import competing_detector_context


def box(label, confidence=0.85, left=0):
    return {
        "label": label,
        "confidence": confidence,
        "left": left,
        "top": 0,
        "right": left + 40,
        "bottom": 30,
    }


class ConflictTest(unittest.TestCase):
    def setUp(self):
        self.row = {"text": "Ω", "box": [0, 0, 40, 30], "proposedLyric": True}

    def test_flags_two_detector_non_lyric_conflict(self):
        raw = {"lyrics": [box("MeasureNumber")], "non-lyric-text": [box("Fingering")]}
        self.assertIsNotNone(competing_detector_context(self.row, raw))

    def test_needs_both_detectors(self):
        self.assertIsNone(
            competing_detector_context(self.row, {"lyrics": [box("MeasureNumber")]})
        )

    def test_does_not_borrow_neighbouring_non_lyric_boxes(self):
        raw = {
            "lyrics": [box("MeasureNumber")],
            "non-lyric-text": [box("Fingering", left=35)],
        }
        self.assertIsNone(competing_detector_context(self.row, raw))

    def test_keeps_short_lyrics_without_conflict(self):
        for text in ["a", "fi", "her", "be", "sé", "Ω", "0"]:
            self.row["text"] = text
            self.assertIsNone(
                competing_detector_context(
                    self.row,
                    {"lyrics": [box("Lyrics")], "non-lyric-text": [box("Lyrics")]},
                )
            )

    def test_does_not_promote_previously_withheld_text(self):
        self.row["proposedLyric"] = False
        raw = {"lyrics": [box("MeasureNumber")], "non-lyric-text": [box("Fingering")]}
        self.assertIsNone(competing_detector_context(self.row, raw))


if __name__ == "__main__":
    unittest.main()
