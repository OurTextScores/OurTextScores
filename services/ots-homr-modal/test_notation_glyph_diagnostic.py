import unittest

import cv2
import numpy as np
from notation_glyph_diagnostic import notation_glyph_context, staff_line_mask


class GlyphContextTest(unittest.TestCase):
    def setUp(self):
        image = np.full((300, 1000), 255, dtype=np.uint8)
        for y in [100, 110, 120, 130, 140]:
            cv2.line(image, (50, y), (950, y), 0, 1)
        cv2.ellipse(image, (500, 120), (12, 7), 0, 0, 360, 0, 2)
        self.lines = staff_line_mask(image)

    def test_flags_note_glyph_without_blacklisting_its_character(self):
        for text in ["Ω", "0", "O"]:
            row = {"text": text, "box": [486, 111, 514, 129], "proposedLyric": True}
            self.assertIsNotNone(notation_glyph_context(row, self.lines))

    def test_keeps_short_lyrics_below_staff(self):
        for text in ["a", "Ω", "0", "fi", "sé"]:
            row = {"text": text, "box": [486, 155, 514, 175], "proposedLyric": True}
            self.assertIsNone(notation_glyph_context(row, self.lines))

    def test_does_not_flag_a_nonempty_word_inside_staff(self):
        row = {"text": "her", "box": [486, 111, 514, 129], "proposedLyric": True}
        self.assertIsNone(notation_glyph_context(row, self.lines))

    def test_needs_five_regular_staff_lines(self):
        row = {"text": "Ω", "box": [486, 111, 514, 129], "proposedLyric": True}
        self.assertIsNone(notation_glyph_context(row, np.zeros_like(self.lines)))


if __name__ == "__main__":
    unittest.main()
