"""The fusion rules that must hold before any calibration exists.

These are the invariants the design names, expressed as tests: a detector contributes
only what it was trained for, raw confidence never decides anything, an unresolved
overlap is review work rather than a coin toss, and the outcome never depends on the
order candidates arrive in.
"""

import itertools
import unittest

from fusion_policy import (
    CLASS_ALLOWLIST,
    DetectorCandidate,
    FusionPolicyError,
    assert_no_prohibited_families,
    conflict_components,
    conflicts,
    gate,
    resolve_component,
)

PAGE = (1000, 1000)


def box(left, top, right, bottom, **kw):
    defaults = dict(
        candidate_id=f"c{left}-{top}",
        detector_id="lyrics",
        label="Lyrics",
        box=(left, top, right, bottom),
        raw_confidence=0.9,
    )
    defaults.update(kw)
    return DetectorCandidate(**defaults)


class TestProhibitedFamilies(unittest.TestCase):
    def test_dynamic_mark_fails_closed_wherever_it_appears(self) -> None:
        with self.assertRaisesRegex(FusionPolicyError, "dynamic.mark"):
            assert_no_prohibited_families(["beam", "dynamic.mark"])

    def test_ordinary_families_pass(self) -> None:
        assert_no_prohibited_families(["beam", "tie", "slur"])


class TestGate(unittest.TestCase):
    def test_a_detector_contributes_only_what_it_was_trained_for(self) -> None:
        # A graph can emit a label its loss never taught; keeping it would turn a known
        # training failure into product output.
        accepted, rejected = gate(
            [
                box(0, 0, 10, 10, detector_id="lyrics", label="Lyrics"),
                box(0, 0, 10, 10, detector_id="lyrics", label="Tempo"),
                box(0, 0, 10, 10, detector_id="non-lyric-text", label="Tempo"),
                box(0, 0, 10, 10, detector_id="non-lyric-text", label="Lyrics"),
            ],
            PAGE,
        )
        self.assertEqual([c.label for c in accepted], ["Lyrics", "Tempo"])
        self.assertEqual([reason for _, reason in rejected], ["unsupported-class"] * 2)

    def test_dynamics_have_one_logical_owner(self) -> None:
        self.assertEqual(CLASS_ALLOWLIST['dynamics'], frozenset({'Dynamic'}))
        for detector in ('lyrics', 'non-lyric-text'):
            self.assertNotIn('Dynamic', CLASS_ALLOWLIST[detector])

    def test_an_unknown_detector_contributes_nothing(self) -> None:
        _, rejected = gate([box(0, 0, 10, 10, detector_id="something-else")], PAGE)
        self.assertEqual(rejected[0][1], "unknown-detector")

    def test_malformed_and_off_page_boxes_are_invalid_evidence(self) -> None:
        for bad in [(10, 10, 5, 20), (10, 10, 20, 5), (-1, 0, 10, 10), (0, 0, 1001, 10)]:
            with self.subTest(box=bad):
                _, rejected = gate([box(*bad)], PAGE)
                self.assertEqual(rejected[0][1], "invalid-box")

    def test_every_rejection_carries_a_reason(self) -> None:
        # A silently dropped candidate cannot be told from one never predicted.
        _, rejected = gate([box(0, 0, 10, 10, label="Fingering")], PAGE)
        self.assertTrue(all(reason for _, reason in rejected))


class TestConflicts(unittest.TestCase):
    def test_touching_edges_is_not_a_conflict(self) -> None:
        self.assertFalse(
            conflicts(
                box(0, 0, 10, 10), box(10, 0, 20, 10),
                iou_threshold=0.3, containment_threshold=0.5,
            )
        )

    def test_containment_is_caught_even_when_iou_is_low(self) -> None:
        # A small label inside a broad region: IoU is tiny, but they compete.
        big = box(0, 0, 100, 100)
        small = box(10, 10, 20, 20)
        self.assertLess(
            (10 * 10) / (100 * 100 + 10 * 10 - 10 * 10), 0.3
        )
        self.assertTrue(
            conflicts(big, small, iou_threshold=0.3, containment_threshold=0.5)
        )

    def test_high_overlap_is_a_conflict_on_iou_alone(self) -> None:
        self.assertTrue(
            conflicts(
                box(0, 0, 100, 100), box(5, 5, 100, 100),
                iou_threshold=0.3, containment_threshold=0.99,
            )
        )


class TestComponents(unittest.TestCase):
    def setUp(self) -> None:
        # One broad candidate overlapping two smaller ones, plus an unrelated region.
        self.broad = box(0, 0, 100, 100, candidate_id="broad")
        self.left = box(5, 5, 20, 20, candidate_id="left")
        self.right = box(60, 60, 80, 80, candidate_id="right")
        self.far = box(500, 500, 560, 560, candidate_id="far")

    def test_transitive_conflicts_resolve_together(self) -> None:
        groups = conflict_components(
            [self.broad, self.left, self.right, self.far],
            iou_threshold=0.3,
            containment_threshold=0.5,
        )
        self.assertEqual(groups, [[0, 1, 2], [3]])

    def test_the_grouping_does_not_depend_on_input_order(self) -> None:
        # Otherwise the outcome of a page depends on which detector ran first.
        candidates = [self.broad, self.left, self.right, self.far]
        signatures = set()
        for order in itertools.permutations(range(4)):
            shuffled = [candidates[i] for i in order]
            groups = conflict_components(
                shuffled, iou_threshold=0.3, containment_threshold=0.5
            )
            signatures.add(
                frozenset(
                    frozenset(shuffled[i].candidate_id for i in group) for group in groups
                )
            )
        self.assertEqual(len(signatures), 1)

    def test_independent_regions_are_all_retained(self) -> None:
        groups = conflict_components(
            [self.far, box(700, 700, 720, 720)],
            iou_threshold=0.3,
            containment_threshold=0.5,
        )
        self.assertEqual(groups, [[0], [1]])


class TestResolve(unittest.TestCase):
    def threshold(self, _label: str) -> float:
        return 0.7

    def test_raw_confidence_can_never_win(self) -> None:
        # It is a mean pixel probability, not comparable across models or classes.
        winner, reason = resolve_component(
            [box(0, 0, 10, 10, raw_confidence=0.99)],
            accept_threshold=self.threshold,
            minimum_margin=0.1,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "below-threshold")

    def test_a_confident_lone_candidate_is_accepted(self) -> None:
        winner, reason = resolve_component(
            [box(0, 0, 10, 10, calibrated_confidence=0.8)],
            accept_threshold=self.threshold,
            minimum_margin=0.1,
        )
        self.assertIsNotNone(winner)
        self.assertEqual(reason, "independent")

    def test_a_lone_candidate_below_its_threshold_is_review_work(self) -> None:
        winner, reason = resolve_component(
            [box(0, 0, 10, 10, calibrated_confidence=0.5)],
            accept_threshold=self.threshold,
            minimum_margin=0.1,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "below-threshold")

    def test_a_close_contest_is_withheld_rather_than_guessed(self) -> None:
        winner, reason = resolve_component(
            [
                box(0, 0, 10, 10, calibrated_confidence=0.81, candidate_id="a"),
                box(1, 1, 11, 11, calibrated_confidence=0.80, candidate_id="b"),
            ],
            accept_threshold=self.threshold,
            minimum_margin=0.1,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "insufficient-margin")

    def test_a_clear_leader_wins(self) -> None:
        winner, reason = resolve_component(
            [
                box(0, 0, 10, 10, calibrated_confidence=0.95, candidate_id="a"),
                box(1, 1, 11, 11, calibrated_confidence=0.40, candidate_id="b"),
            ],
            accept_threshold=self.threshold,
            minimum_margin=0.1,
        )
        self.assertEqual(winner.candidate_id, "a")
        self.assertEqual(reason, "calibrated-winner")

    def test_a_class_with_no_threshold_stays_review_only(self) -> None:
        # A sparse class without enough evidence to calibrate must not be promoted by
        # falling back to a detector-wide number.
        winner, reason = resolve_component(
            [box(0, 0, 10, 10, calibrated_confidence=0.99)],
            accept_threshold=lambda _label: None,
            minimum_margin=0.1,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "below-threshold")


if __name__ == "__main__":
    unittest.main()
