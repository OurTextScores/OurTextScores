"""The manifest is the policy, so its failures have to be loud.

Every check here exists because the corresponding mistake would otherwise be silent: a
different detector still returns boxes with confidences that look exactly like the
calibrated ones, and an edited manifest still loads.
"""

import json
import tempfile
import unittest
from pathlib import Path

from calibration_manifest import (
    CalibrationManifestError,
    load_calibration_manifest,
)
from fusion_policy import DetectorCandidate, resolve_component

PINNED = Path(__file__).parent / "calibration" / "lyrics-only-v1.json"
ARTIFACT_SHA = "deafed32b69e4367ab548439e1eabd1c0b83726d80012811f33fadae250c4bdd"
REVISION = "142d4f42d3a6bbc90477fc41851df5e60cc7603f"


def rewritten(**changes):
    """The pinned manifest with fields changed, re-digested unless asked otherwise."""
    data = json.loads(PINNED.read_text())
    keep_revision = changes.pop("_keep_revision", False)
    data.update(changes)
    if not keep_revision:
        body = {k: v for k, v in data.items() if k != "policyRevision"}
        import hashlib

        data["policyRevision"] = hashlib.sha256(
            json.dumps(body, indent=1, sort_keys=True).encode()
        ).hexdigest()
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    handle.write(json.dumps(data, indent=1, sort_keys=True))
    handle.close()
    return handle.name


class ThePinnedManifest(unittest.TestCase):
    def setUp(self):
        self.manifest = load_calibration_manifest(PINNED)

    def test_pins_one_detector_at_an_exact_artifact(self):
        self.assertEqual(list(self.manifest.detectors), ["lyrics"])
        self.assertEqual(self.manifest.detectors["lyrics"].sha256, ARTIFACT_SHA)
        self.assertEqual(self.manifest.detectors["lyrics"].revision, REVISION)

    def test_allows_only_the_classes_that_detector_was_trained_on(self):
        self.assertEqual(
            self.manifest.class_allowlist["lyrics"], frozenset({"Lyrics", "Dynamic"})
        )

    def test_accepts_lyrics_at_the_calibrated_value_of_raw_070(self):
        threshold = self.manifest.accept_threshold("lyrics")
        self.assertAlmostEqual(threshold("Lyrics"), 0.7857)

    def test_leaves_dynamics_to_the_core(self):
        # Invariant 6: the rareNum core is the sole automatic authority on dynamics.
        self.assertIsNone(self.manifest.accept_threshold("lyrics")("Dynamic"))
        self.assertIsNone(self.manifest.calibrate("lyrics", "Dynamic", 0.99))

    def test_raw_070_is_exactly_the_operating_point_that_was_chosen(self):
        # The measured table was read at raw 0.70; a calibration that put 0.70 on the
        # wrong side of the accept line would ship a different policy than was decided.
        threshold = self.manifest.accept_threshold("lyrics")("Lyrics")
        self.assertGreaterEqual(self.manifest.calibrate("lyrics", "Lyrics", 0.70), threshold)
        self.assertLess(self.manifest.calibrate("lyrics", "Lyrics", 0.699), threshold)

    def test_calibration_is_monotone(self):
        # Pool-adjacent-violators exists to guarantee this; without it a higher raw score
        # could be less likely to be a lyric, and a raw operating point would not map to
        # a calibrated one at all.
        values = [
            self.manifest.calibrate("lyrics", "Lyrics", c)
            for c in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
        ]
        self.assertEqual(values, sorted(values))

    def test_scores_below_the_lowest_bin_are_uncalibrated_rather_than_zero(self):
        # Nothing under 0.5 was sampled, so there is no evidence for a value there.
        # None keeps such a box out of the automatic path; zero would be a claim.
        self.assertIsNone(self.manifest.calibrate("lyrics", "Lyrics", 0.49))

    def test_geometry_thresholds_are_present_for_surfacing_overlaps(self):
        self.assertEqual(self.manifest.iou_threshold, 0.3)
        self.assertEqual(self.manifest.containment_threshold, 0.6)


class RefusingTheWrongModel(unittest.TestCase):
    def setUp(self):
        self.manifest = load_calibration_manifest(PINNED)

    def test_accepts_the_artifact_it_calibrated(self):
        self.manifest.assert_detector_matches("lyrics", sha256=ARTIFACT_SHA, revision=REVISION)

    def test_refuses_a_different_artifact(self):
        # The numbers describe one exact file. Applying them to another is not a smaller
        # claim, it is an unfounded one.
        with self.assertRaises(CalibrationManifestError):
            self.manifest.assert_detector_matches("lyrics", sha256="0" * 64)

    def test_refuses_a_different_revision_of_the_same_name(self):
        with self.assertRaises(CalibrationManifestError):
            self.manifest.assert_detector_matches(
                "lyrics", sha256=ARTIFACT_SHA, revision="deadbeef"
            )

    def test_refuses_a_detector_it_does_not_calibrate(self):
        with self.assertRaises(CalibrationManifestError):
            self.manifest.assert_detector_matches("non-lyric-text", sha256=ARTIFACT_SHA)

    def test_compares_sha_case_insensitively(self):
        self.manifest.assert_detector_matches("lyrics", sha256=ARTIFACT_SHA.upper())


class RefusingABadManifest(unittest.TestCase):
    def test_refuses_one_edited_since_it_was_pinned(self):
        # The revision is the digest of the contents, so a quiet edit stops matching its
        # own name instead of shipping under it.
        path = rewritten(_keep_revision=True, minimumWinnerMargin=0.9)
        with self.assertRaises(CalibrationManifestError) as caught:
            load_calibration_manifest(path)
        self.assertIn("edited", str(caught.exception))

    def test_refuses_an_unknown_schema(self):
        path = rewritten(schemaVersion="something.else.v9")
        with self.assertRaises(CalibrationManifestError):
            load_calibration_manifest(path)

    def test_refuses_a_detector_entry_missing_its_sha(self):
        path = rewritten(detectors={"lyrics": {"repository": "r", "revision": "v", "artifact": "a"}})
        with self.assertRaises(CalibrationManifestError):
            load_calibration_manifest(path)

    def test_refuses_a_manifest_pinning_nothing(self):
        path = rewritten(detectors={})
        with self.assertRaises(CalibrationManifestError):
            load_calibration_manifest(path)


class DrivingTheResolver(unittest.TestCase):
    """The manifest has to work as `resolve_component` expects, not merely parse."""

    def setUp(self):
        self.manifest = load_calibration_manifest(PINNED)

    def candidate(self, label, raw, box=(0, 0, 10, 10)):
        return DetectorCandidate(
            candidate_id=f"{label}-{raw}",
            detector_id="lyrics",
            label=label,
            box=box,
            raw_confidence=raw,
            calibrated_confidence=self.manifest.calibrate("lyrics", label, raw),
        )

    def test_a_confident_lyric_is_accepted(self):
        winner, reason = resolve_component(
            [self.candidate("Lyrics", 0.85)],
            accept_threshold=self.manifest.accept_threshold("lyrics"),
            minimum_margin=self.manifest.minimum_winner_margin,
        )
        self.assertIsNotNone(winner)
        self.assertEqual(reason, "independent")

    def test_a_lyric_below_the_line_is_review_work(self):
        winner, reason = resolve_component(
            [self.candidate("Lyrics", 0.65)],
            accept_threshold=self.manifest.accept_threshold("lyrics"),
            minimum_margin=self.manifest.minimum_winner_margin,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "below-threshold")

    def test_a_dynamic_can_never_win_however_confident(self):
        # Uncalibrated by design, and `resolve_component` refuses an uncalibrated
        # candidate -- so the core keeps dynamics without needing a second rule.
        winner, reason = resolve_component(
            [self.candidate("Dynamic", 0.99)],
            accept_threshold=self.manifest.accept_threshold("lyrics"),
            minimum_margin=self.manifest.minimum_winner_margin,
        )
        self.assertIsNone(winner)
        self.assertEqual(reason, "below-threshold")

    def test_a_lyric_overlapping_a_dynamic_still_resolves_to_the_lyric(self):
        # The only conflict this policy can produce. The dynamic is not eligible, so the
        # overlap does not withhold a lyric that has cleared its threshold.
        winner, _ = resolve_component(
            [self.candidate("Lyrics", 0.9), self.candidate("Dynamic", 0.95)],
            accept_threshold=self.manifest.accept_threshold("lyrics"),
            minimum_margin=self.manifest.minimum_winner_margin,
        )
        self.assertIsNotNone(winner)
        self.assertEqual(winner.label, "Lyrics")


if __name__ == "__main__":
    unittest.main()
