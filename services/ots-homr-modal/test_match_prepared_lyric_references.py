import unittest

from match_prepared_lyric_references import possible_matches


def target(id, text, measure=1, ordinal=1, verse="1"):
    return {
        "targetId": id,
        "target": {
            "text": text,
            "physical_measure": measure,
            "source_note_ordinal": ordinal,
            "source_part": "P1",
            "verse": verse,
        },
    }


class ReferenceMatches(unittest.TestCase):
    def test_merged_syllables_require_whole_text(self):
        rows = [target("a", "som"), target("b", "bres", ordinal=2)]
        self.assertEqual(possible_matches("som-bres", rows, 1, 1), [["a", "b"]])
        self.assertEqual(possible_matches("som-bres extra", rows, 1, 1), [])

    def test_repeated_syllable_is_ambiguous(self):
        self.assertEqual(
            len(
                possible_matches(
                    "la", [target("a", "la"), target("b", "la", ordinal=2)], 1, 1
                )
            ),
            2,
        )

    def test_does_not_join_verses_or_leave_window(self):
        rows = [
            target("a", "som"),
            target("b", "bres", verse="2"),
            target("c", "loin", measure=2),
        ]
        self.assertEqual(possible_matches("sombres", rows, 1, 1), [])
        self.assertEqual(possible_matches("loin", rows, 1, 1), [])

    def test_no_fuzzy_or_empty_match(self):
        self.assertEqual(possible_matches("fi", [target("a", "foi")], 1, 1), [])
        self.assertEqual(possible_matches("_", [target("a", "foi")], 1, 1), [])


if __name__ == "__main__":
    unittest.main()
