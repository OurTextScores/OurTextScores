"""Shadow mode has one job beyond running the pipeline: to be unable to change anything,
and to say why every candidate it withheld was withheld.

A count of acceptances says a policy runs. Only the reasons say whether the boxes it kept
out were the ones it should have, which is the question a shadow run exists to answer
before a threshold reaches a score.
"""

import unittest
from pathlib import Path

from calibration_manifest import load_calibration_manifest
from shadow_fusion import shadow_page, shadow_totals

MANIFEST = load_calibration_manifest(
    Path(__file__).parent / "calibration" / "lyrics-only-v1.json"
)
PAGE = (1000, 1400)


def run(boxes, page="p1"):
    return shadow_page(
        page=page, detector_id="lyrics", boxes=boxes, manifest=MANIFEST, page_size=PAGE
    )


class WhatItAccepts(unittest.TestCase):
    def test_accepts_a_lyric_above_the_calibrated_line(self):
        report = run([("Lyrics", (10, 10, 60, 30), 0.85)])
        self.assertEqual(len(report.accepted), 1)
        self.assertEqual(report.accepted[0].reason, "independent")
        self.assertAlmostEqual(report.accepted[0].calibrated_confidence, 0.8929)

    def test_withholds_a_lyric_below_the_line_and_says_so(self):
        report = run([("Lyrics", (10, 10, 60, 30), 0.62)])
        self.assertEqual(report.accepted, [])
        self.assertEqual(report.decisions[0].reason, "below-threshold")

    def test_raw_070_is_accepted_and_0699_is_not(self):
        # The operating point that was chosen. A calibration that moved it would ship a
        # different policy under the same name.
        self.assertEqual(len(run([("Lyrics", (0, 0, 50, 20), 0.70)]).accepted), 1)
        self.assertEqual(len(run([("Lyrics", (0, 0, 50, 20), 0.699)]).accepted), 0)

    def test_never_accepts_a_dynamic(self):
        # Uncalibrated by design, so the rareNum core keeps dynamics.
        report = run([("Dynamic", (10, 10, 40, 26), 0.99)])
        self.assertEqual(report.accepted, [])
        self.assertEqual(report.decisions[0].reason, "below-threshold")


class WhatItRefusesBeforeScoring(unittest.TestCase):
    def test_gates_a_class_this_detector_was_never_trained_on(self):
        # The detector emits labels its loss gave it no gradient on; preserving one
        # would turn a known training failure into product output.
        report = run([("Tempo", (10, 10, 80, 30), 0.95)])
        self.assertEqual(report.accepted, [])
        self.assertEqual(report.rejected[0][1], "unsupported-class")
        self.assertIn("gated:unsupported-class", report.counts())

    def test_gates_a_box_outside_the_page(self):
        report = run([("Lyrics", (900, 10, 1200, 40), 0.95)])
        self.assertEqual(report.rejected[0][1], "invalid-box")

    def test_counts_every_prediction_including_the_gated_ones(self):
        report = run(
            [
                ("Lyrics", (10, 10, 60, 30), 0.95),
                ("Tempo", (10, 100, 60, 130), 0.95),
                ("Lyrics", (10, 200, 60, 230), 0.51),
            ]
        )
        counts = report.counts()
        self.assertEqual(counts["predicted"], 3)
        self.assertEqual(counts["accepted"], 1)
        self.assertEqual(counts["gated:unsupported-class"], 1)
        self.assertEqual(counts["withheld:below-threshold"], 1)


class Overlaps(unittest.TestCase):
    def test_a_lyric_overlapping_a_dynamic_still_wins(self):
        # The only conflict this policy can produce. The dynamic is not eligible, so the
        # overlap must not withhold a lyric that cleared its threshold.
        report = run(
            [("Lyrics", (10, 10, 90, 40), 0.92), ("Dynamic", (12, 12, 88, 38), 0.99)]
        )
        self.assertEqual([d.label for d in report.accepted], ["Lyrics"])

    def test_the_loser_of_a_component_is_not_called_below_threshold(self):
        # It was not below anything; saying so would misattribute the reason and make a
        # report of withholdings useless for finding real threshold problems.
        report = run(
            [("Lyrics", (10, 10, 90, 40), 0.92), ("Dynamic", (12, 12, 88, 38), 0.99)]
        )
        loser = next(d for d in report.decisions if d.label == "Dynamic")
        self.assertEqual(loser.reason, "lost-component")

    def test_two_lyrics_that_do_not_touch_are_judged_independently(self):
        report = run(
            [("Lyrics", (10, 10, 60, 30), 0.95), ("Lyrics", (500, 600, 560, 630), 0.55)]
        )
        self.assertEqual(len(report.accepted), 1)
        self.assertEqual(
            sorted(d.reason for d in report.decisions), ["below-threshold", "independent"]
        )


class ItChangesNothing(unittest.TestCase):
    def test_the_report_carries_no_score_and_no_write_path(self):
        # The point of a shadow run is that its output cannot be mistaken for a change.
        report = run([("Lyrics", (10, 10, 60, 30), 0.95)])
        self.assertFalse(hasattr(report, "musicXml"))
        self.assertFalse(any(hasattr(report, name) for name in ("apply", "write", "save")))

    def test_names_the_policy_and_revision_that_produced_it(self):
        # A report read later has to say which policy decided it, or it cannot be
        # compared against the next one.
        report = run([("Lyrics", (10, 10, 60, 30), 0.95)])
        self.assertEqual(report.policy, "lyrics-only-v1")
        self.assertEqual(report.policy_revision, MANIFEST.policy_revision)

    def test_is_a_function_of_its_input_alone(self):
        boxes = [("Lyrics", (10, 10, 60, 30), 0.95), ("Dynamic", (12, 12, 58, 28), 0.9)]
        first = run(boxes).counts()
        second = run(list(reversed(boxes))).counts()
        self.assertEqual(first, second)


class AcrossPages(unittest.TestCase):
    def test_totals_sum_every_page(self):
        reports = [
            run([("Lyrics", (10, 10, 60, 30), 0.95)], page="a"),
            run([("Lyrics", (10, 10, 60, 30), 0.55), ("Tempo", (10, 60, 60, 90), 0.9)], page="b"),
        ]
        totals = shadow_totals(reports)
        self.assertEqual(totals["predicted"], 3)
        self.assertEqual(totals["accepted"], 1)
        self.assertEqual(totals["withheld:below-threshold"], 1)
        self.assertEqual(totals["gated:unsupported-class"], 1)

    def test_an_empty_page_is_a_success_not_a_gap(self):
        # The design's own rule: a page with no text is a correct answer.
        report = run([], page="silent")
        self.assertEqual(report.counts(), {"predicted": 0, "accepted": 0})


if __name__ == "__main__":
    unittest.main()
