import unittest
import xml.etree.ElementTree as ET

from prepare_c1_lyric_references import lyrics


class SourceLyricsTest(unittest.TestCase):
    def test_backup_chord_verse_elision_and_melisma_keep_source_ownership(self):
        root = ET.fromstring("""<score-partwise><part id="P1"><measure number="9">
          <attributes><divisions>2</divisions></attributes>
          <note><duration>2</duration><voice>1</voice><lyric number="1"><syllabic>begin</syllabic><text>Hal</text></lyric></note>
          <note><chord/><duration>2</duration><lyric number="2"><text>o</text><elision> </elision><text>du</text></lyric></note>
          <backup><duration>2</duration></backup>
          <note><duration>4</duration><voice>2</voice><staff>2</staff><lyric number="1"><extend type="start"/></lyric></note>
        </measure></part></score-partwise>""")
        rows = lyrics(root, "IMSLP123")
        self.assertEqual([r["onset_quarters"] for r in rows], ["0", "0", "0"])
        self.assertEqual(rows[1]["text"], "o du")
        self.assertEqual(rows[1]["verse_number"], "2")
        self.assertEqual(rows[2]["source_note_ordinal"], 3)
        self.assertEqual(rows[2]["staff"], "2")
        self.assertEqual(rows[2]["text"], "")
        self.assertEqual(rows[2]["segments"][0]["attributes"]["type"], "start")
        self.assertEqual(rows[0]["physical_measure"], 1)
        self.assertEqual(rows[0]["printed_measure"], "9")
        self.assertEqual(rows[0]["scan_linkage"], "uncertified")

    def test_missing_divisions_fail_instead_of_guessing_time(self):
        root = ET.fromstring(
            "<score-partwise><part><measure><note><duration>1</duration></note></measure></part></score-partwise>"
        )
        with self.assertRaisesRegex(ValueError, "Duration before"):
            lyrics(root, "IMSLP123")

    def test_unsupported_layout_does_not_silently_emit_empty_targets(self):
        with self.assertRaisesRegex(ValueError, "score-partwise"):
            lyrics(ET.fromstring("<score-timewise/>"), "IMSLP123")


if __name__ == "__main__":
    unittest.main()
