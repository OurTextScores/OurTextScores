import unittest

from homr_confidence import _softmax, _top_k
from homr_review import remaining_floor, select_spots


def head(chosen, confidence, alternatives):
    return {
        "chosen": chosen,
        "confidence": confidence,
        "alternatives": [{"value": v, "confidence": c} for v, c in alternatives],
    }


def staff(index, symbols):
    return {"index": index, "region": [0, 0, 100, 50], "symbols": symbols}


def symbol(index, heads, attention=None):
    return {"index": index, "rhythm": "note_4", "heads": heads, "attention": attention}


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


class SelectSpotsTest(unittest.TestCase):
    def test_ranks_strictly_by_ascending_confidence(self):
        # The queue's whole value is that "everything left is at least X%" is
        # true, which requires monotonic ordering rather than a weighting.
        staves = [
            staff(
                0,
                [
                    symbol(1, {"pitch": head("C4", 0.72, [("D4", 0.20)])}),
                    symbol(2, {"pitch": head("E4", 0.41, [("F4", 0.39)])}),
                    symbol(3, {"rhythm": head("note_8", 0.55, [("note_16", 0.40)])}),
                ],
            )
        ]
        spots = select_spots(staves)
        self.assertEqual([round(s["confidence"], 2) for s in spots], [0.41, 0.55, 0.72])

    def test_skips_confident_heads(self):
        staves = [staff(0, [symbol(1, {"pitch": head("C4", 0.97, [("D4", 0.02)])})])]
        self.assertEqual(select_spots(staves), [])

    def test_skips_uncertainty_with_no_plausible_alternative(self):
        # 0.60 vs 0.05 is doubt with nothing to offer instead; asking would
        # present a choice the model does not actually consider close.
        staves = [staff(0, [symbol(1, {"pitch": head("C4", 0.60, [("D4", 0.05)])})])]
        self.assertEqual(select_spots(staves), [])

    def test_low_impact_heads_must_be_more_doubtful(self):
        # A slur at 0.60 is below the general floor but not worth interrupting
        # for; the same confidence on a pitch is.
        slur_only = [staff(0, [symbol(1, {"slur": head("slur", 0.60, [("none", 0.39)])})])]
        self.assertEqual(select_spots(slur_only), [])

        pitch_only = [staff(0, [symbol(1, {"pitch": head("C4", 0.60, [("D4", 0.39)])})])]
        self.assertEqual(len(select_spots(pitch_only)), 1)

        very_doubtful_slur = [
            staff(0, [symbol(1, {"slur": head("slur", 0.44, [("none", 0.42)])})])
        ]
        self.assertEqual(len(select_spots(very_doubtful_slur)), 1)

    def test_does_not_ask_about_internal_heads(self):
        # `position` is a grand-staff assignment, not something a reviewer can
        # judge from a crop.
        staves = [staff(0, [symbol(1, {"position": head("upper", 0.30, [("lower", 0.29)])})])]
        self.assertEqual(select_spots(staves), [])

    def test_order_is_stable_for_equal_confidence(self):
        staves = [
            staff(1, [symbol(9, {"pitch": head("C4", 0.5, [("D4", 0.4)])})]),
            staff(0, [symbol(2, {"pitch": head("C4", 0.5, [("D4", 0.4)])})]),
        ]
        spots = select_spots(staves)
        self.assertEqual([(s["staffIndex"], s["symbolIndex"]) for s in spots], [(0, 2), (1, 9)])


class RemainingFloorTest(unittest.TestCase):
    def test_rises_as_the_reviewer_works(self):
        staves = [
            staff(
                0,
                [
                    symbol(1, {"pitch": head("C4", 0.40, [("D4", 0.35)])}),
                    symbol(2, {"pitch": head("E4", 0.60, [("F4", 0.30)])}),
                    symbol(3, {"pitch": head("G4", 0.75, [("A4", 0.20)])}),
                ],
            )
        ]
        spots = select_spots(staves)
        self.assertAlmostEqual(remaining_floor(spots, 0), 0.40)
        self.assertAlmostEqual(remaining_floor(spots, 1), 0.60)
        self.assertAlmostEqual(remaining_floor(spots, 2), 0.75)
        self.assertIsNone(remaining_floor(spots, 3))


if __name__ == "__main__":
    unittest.main()
