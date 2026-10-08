import unittest

from calibration_manifest import CalibrationManifest, DetectorIdentity
from fusion_policy import CLASS_ALLOWLIST, FusionPolicyError
from fusion_v1 import fuse_page


def manifest():
    return CalibrationManifest(
        policy="fusion-v1",
        policy_revision="test",
        detectors={
            detector_id: DetectorIdentity("test", detector_id, "test.pth", detector_id)
            for detector_id in CLASS_ALLOWLIST
        },
        class_allowlist=CLASS_ALLOWLIST,
        calibration={
            "lyrics": {"Lyrics": {"binLowerEdges": [0.0], "binValues": [0.9]}},
            "non-lyric-text": {"Tempo": {"binLowerEdges": [0.0], "binValues": [0.8]}},
        },
        accept={"lyrics": {"Lyrics": 0.7}, "non-lyric-text": {"Tempo": 0.7}},
        iou_threshold=0.3,
        containment_threshold=0.6,
        minimum_winner_margin=0.1,
    )


IDENTITIES = {detector_id: (detector_id, detector_id) for detector_id in CLASS_ALLOWLIST}


def box(label, left, top, right, bottom, confidence=0.9):
    return dict(label=label, left=left, top=top, right=right, bottom=bottom, confidence=confidence)


def run(detections, **kwargs):
    detections = {'dynamics': [], **detections}
    return fuse_page(
        page_sha256="page",
        page_size=(100, 100),
        detections=detections,
        detector_identities=kwargs.pop("identities", IDENTITIES),
        manifest=kwargs.pop("calibration", manifest()),
    )


class FusionV1Test(unittest.TestCase):
    def test_empty_page_is_success_but_missing_detector_fails(self):
        result = run({"lyrics": [], "non-lyric-text": []})
        self.assertEqual(result.summary, {"accepted": 0, "review": 0, "rejected": 0, "rejectedByReason": {}, "rejectedByClass": {}, "byClass": {}})
        with self.assertRaisesRegex(FusionPolicyError, "all three logical detector runs"):
            run({"lyrics": []})

    def test_independent_boxes_survive_and_unsupported_class_is_rejected(self):
        result = run({
            "lyrics": [box("Lyrics", 0, 0, 10, 10), box("MeasureNumber", 80, 0, 90, 10)],
            "non-lyric-text": [box("Tempo", 30, 0, 40, 10)],
        })
        self.assertEqual(
            result.summary,
            {
                "accepted": 2,
                "review": 0,
                "rejected": 1,
                "rejectedByReason": {"unsupported-class": 1},
                "rejectedByClass": {"MeasureNumber": 1},
                "byClass": {"Lyrics": 1, "Tempo": 1},
            },
        )
        # Rejected candidates are counted, not listed.
        self.assertEqual({r["status"] for r in result.regions}, {"accepted"})

    def test_hundreds_of_rejected_boxes_do_not_become_regions(self):
        many = [box("Fingering", i * 12, 0, i * 12 + 10, 10) for i in range(600)]
        result = run({"lyrics": many + [box("Lyrics", 0, 50, 10, 60)], "non-lyric-text": []})
        self.assertEqual(len(result.regions), 1)
        self.assertEqual(result.summary["rejected"], 600)
        self.assertEqual(result.summary["rejectedByReason"], {"unsupported-class": 600})

    def test_uncalibrated_overlap_is_review_not_raw_confidence_winner(self):
        result = run({
            "lyrics": [box("Lyrics", 0, 0, 10, 10, 0.51)],
            "non-lyric-text": [],
            "dynamics": [box("Dynamic", 0, 0, 10, 10, 0.99)],
        })
        self.assertEqual(result.summary["accepted"], 0)
        self.assertEqual(result.regions[0]["reason"], "uncalibrated-conflict")

    def test_fusion_is_independent_of_detector_box_order(self):
        lyrics = [box("Lyrics", 0, 0, 10, 10), box("Lyrics", 50, 0, 60, 10)]
        non_lyric = [box("Tempo", 0, 0, 10, 10), box("Tempo", 75, 0, 85, 10)]
        first = run({"lyrics": lyrics, "non-lyric-text": non_lyric})
        second = run({"lyrics": list(reversed(lyrics)), "non-lyric-text": list(reversed(non_lyric))})
        self.assertEqual(first, second)

    def test_model_identity_and_policy_must_match(self):
        with self.assertRaisesRegex(Exception, "refusing fusion-v1"):
            run({"lyrics": [], "non-lyric-text": []}, identities={**IDENTITIES, "lyrics": ("lyrics", "wrong")})
        wrong = manifest()
        object.__setattr__(wrong, "policy", "lyrics-only-v1")
        with self.assertRaisesRegex(FusionPolicyError, "own calibration"):
            run({"lyrics": [], "non-lyric-text": []}, calibration=wrong)

    def test_missing_dynamics_route_fails_even_when_other_runs_are_empty(self):
        with self.assertRaisesRegex(FusionPolicyError, 'all three logical detector runs'):
            fuse_page(page_sha256='page', page_size=(100, 100),
                      detections={'lyrics': [], 'non-lyric-text': []},
                      detector_identities=IDENTITIES, manifest=manifest())

    def test_calibrated_dynamic_is_still_review_only(self):
        calibration = manifest()
        calibration.calibration['dynamics'] = {'Dynamic': {'binLowerEdges': [0.0], 'binValues': [1.0]}}
        calibration.accept['dynamics'] = {'Dynamic': 0.1}
        result = run({'lyrics': [], 'non-lyric-text': [],
                      'dynamics': [box('Dynamic', 0, 0, 10, 10)]}, calibration=calibration)
        self.assertEqual(result.summary['accepted'], 0)
        self.assertEqual(result.regions[0]['reason'], 'dynamic-review-only')
        self.assertEqual(result.regions[0]['candidates'][0]['physicalDetectorId'], 'non-lyric-text')

    def test_calibration_cannot_silently_add_a_detector(self):
        calibration = manifest()
        calibration.detectors['unexpected'] = calibration.detectors['dynamics']
        with self.assertRaisesRegex(FusionPolicyError, 'exactly three logical routes'):
            run({'lyrics': [], 'non-lyric-text': []}, calibration=calibration)


if __name__ == "__main__":
    unittest.main()
