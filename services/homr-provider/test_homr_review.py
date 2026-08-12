import unittest
from types import SimpleNamespace

from homr_confidence import PageCapture, _softmax, _top_k
from homr_review import prune_staves


def head(chosen, confidence, alternatives):
    return {
        "chosen": chosen,
        "confidence": confidence,
        "alternatives": [{"value": v, "confidence": c} for v, c in alternatives],
    }


def staff(index, symbols):
    return {"index": index, "region": [0, 0, 100, 50], "symbols": symbols}


def symbol(index, heads):
    return {"index": index, "rhythm": "note_4", "heads": heads, "attention": None}


class SoftmaxTest(unittest.TestCase):
    def test_normalises_and_orders(self):
        probabilities = _softmax([2.0, 1.0, 0.1])
        self.assertAlmostEqual(sum(probabilities), 1.0, places=9)
        self.assertGreater(probabilities[0], probabilities[1])

    def test_large_logits_do_not_overflow(self):
        # The stable form matters: exp(1000) is inf.
        probabilities = _softmax([1000.0, 999.0])
        self.assertAlmostEqual(sum(probabilities), 1.0, places=9)

    def test_top_k_returns_ranked_tokens(self):
        ranked = _top_k([0.1, 0.7, 0.2], {0: "a", 1: "b", 2: "c"}, 2)
        self.assertEqual([entry["value"] for entry in ranked], ["b", "c"])


class PruneTest(unittest.TestCase):
    def test_drops_symbols_the_model_was_sure_about(self):
        staves = [
            staff(
                0,
                [
                    symbol(1, {"pitch": head("C4", 0.999, [("D4", 0.0005)])}),
                    symbol(2, {"pitch": head("E4", 0.41, [("F4", 0.39)])}),
                ],
            )
        ]
        pruned = prune_staves(staves)
        self.assertEqual([s["index"] for s in pruned[0]["symbols"]], [2])

    def test_keeps_a_symbol_when_any_head_is_doubtful(self):
        staves = [
            staff(0, [symbol(1, {
                "pitch": head("C4", 0.99, [("D4", 0.005)]),
                "rhythm": head("note_8", 0.52, [("note_16", 0.40)]),
            })])
        ]
        self.assertEqual(len(prune_staves(staves)[0]["symbols"]), 1)

    def test_prune_floor_sits_above_any_selection_floor(self):
        # Pruning must never remove something selection would have asked about.
        from homr_review import PRUNE_FLOOR

        self.assertGreaterEqual(PRUNE_FLOOR, 0.90)

    def test_drops_heads_a_reviewer_cannot_judge(self):
        staves = [staff(0, [symbol(1, {"position": head("upper", 0.3, [("lower", 0.29)])})])]
        self.assertEqual(prune_staves(staves)[0]["symbols"], [])

    def test_keeps_staff_geometry_even_with_no_symbols(self):
        staves = [staff(0, [symbol(1, {"pitch": head("C4", 0.999, [("D4", 0.0005)])})])]
        pruned = prune_staves(staves)
        self.assertEqual(pruned[0]["region"], [0, 0, 100, 50])


class VoiceSystemMappingTest(unittest.TestCase):
    def test_assigns_voice_major_physical_staves_to_parts_and_systems(self):
        page = PageCapture()
        page.staves = [
            {"index": 0, "tokens": [["note"]]},
            {"index": 1, "tokens": [["note"]]},
            {"index": 2, "tokens": [["note"]]},
            {"index": 3, "tokens": [["note"]]},
        ]
        voice = [SimpleNamespace(rhythm="note_4"), SimpleNamespace(rhythm="newline")] * 2

        page.assign_voice_systems([voice, voice])

        self.assertEqual(
            [(staff["partIndex"], staff["systemIndex"]) for staff in page.staves],
            [(0, 0), (0, 1), (1, 0), (1, 1)],
        )

    def test_leaves_mapping_absent_when_newline_counts_do_not_prove_it(self):
        page = PageCapture()
        page.staves = [{"index": 0, "tokens": [["note"]]}]

        page.assign_voice_systems([[SimpleNamespace(rhythm="note_4")]])

        self.assertNotIn("partIndex", page.staves[0])


class BarLineCaptureTest(unittest.TestCase):
    @staticmethod
    def line(x, y, width, height):
        return SimpleNamespace(center=(x, y), size=(width, height))

    def test_assigns_segmented_bar_lines_that_intersect_the_staff_region(self):
        page = PageCapture()
        page.record_detected_bar_lines(
            [
                self.line(10, 50, 2, 80),
                self.line(55, 110, 2, 80),
                self.line(90, 50, 2, 80),
            ]
        )

        # The line at x=55 spans into this staff even though its centre is
        # below the region. That is how one system bar line belongs to each
        # staff it crosses.
        self.assertEqual(page.bar_lines_for_region([0, 10, 100, 80]), [10, 55, 90])

    def test_rejects_lines_outside_the_staff_extent_and_deduplicates_centres(self):
        page = PageCapture()
        page.record_detected_bar_lines(
            [
                self.line(-5, 40, 2, 20),
                self.line(50.2, 40, 2, 20),
                self.line(50.4, 40, 2, 20),
                self.line(105, 40, 2, 20),
                self.line(75, 200, 2, 20),
            ]
        )

        self.assertEqual(page.bar_lines_for_region([0, 0, 100, 100]), [50])

    def test_matches_decoder_boundaries_to_physical_candidates_in_order(self):
        page = PageCapture()
        accepted = [
            self.line(100, 40, 2, 50),
            self.line(400, 40, 2, 50),  # segmentation false positive
            self.line(700, 40, 2, 50),
            self.line(900, 40, 2, 50),
        ]
        candidates = [*accepted, self.line(600, 40, 8, 35)]
        page.record_detected_bar_lines(accepted, candidates)
        symbols = [
            SimpleNamespace(rhythm="barline", coordinates=(105, 20)),
            SimpleNamespace(rhythm="repeatEnd", coordinates=(595, 20)),
            SimpleNamespace(rhythm="barline", coordinates=(895, 20)),
        ]

        self.assertEqual(
            page.matched_bar_lines_for_staff([0, 0, 1280, 100], symbols),
            [100, 600, 900],
        )


if __name__ == "__main__":
    unittest.main()
