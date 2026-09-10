"""A malformed profile is refused, never dropped.

Silently ignoring one would make the feature untestable from outside and let a caller
believe a prior was in force when it was not.
"""

import unittest

from score_profile_policy import SCORE_PROFILE_SCHEMA_VERSION, validate_score_profile


def quartet() -> dict:
    return {
        "schemaVersion": SCORE_PROFILE_SCHEMA_VERSION,
        "parts": [
            {"stableId": "violin-1", "likelyClefs": ["G2"]},
            {"stableId": "violin-2", "likelyClefs": ["G2"]},
            {"stableId": "viola", "likelyClefs": ["C3", "G2"]},
            # All three are ordinary for a cello; a profile naming only bass would
            # raise a finding on real music.
            {"stableId": "cello", "likelyClefs": ["F4", "C4", "G2"]},
        ],
    }


class TestValidateScoreProfile(unittest.TestCase):
    def test_a_well_formed_profile_passes(self) -> None:
        validate_score_profile(quartet())

    def test_a_schema_it_cannot_read_is_refused(self) -> None:
        profile = quartet() | {"schemaVersion": "homr.score-profile.v2"}
        with self.assertRaisesRegex(ValueError, "unsupported schema"):
            validate_score_profile(profile)

    def test_a_missing_schema_is_refused(self) -> None:
        profile = quartet()
        del profile["schemaVersion"]
        with self.assertRaises(ValueError):
            validate_score_profile(profile)

    def test_duplicate_ids_are_refused(self) -> None:
        profile = quartet()
        profile["parts"][1]["stableId"] = "violin-1"
        with self.assertRaisesRegex(ValueError, "duplicate stableId"):
            validate_score_profile(profile)

    def test_a_part_without_a_usable_id_is_refused(self) -> None:
        for bad in ({}, {"stableId": ""}, {"stableId": "   "}, {"stableId": 7}):
            with self.subTest(part=bad):
                with self.assertRaises(ValueError):
                    validate_score_profile({**quartet(), "parts": [bad]})

    def test_an_empty_or_non_list_parts_is_refused(self) -> None:
        for parts in ([], "violin", {}, None):
            with self.subTest(parts=parts):
                with self.assertRaises(ValueError):
                    validate_score_profile({**quartet(), "parts": parts})

    def test_a_non_object_profile_is_refused(self) -> None:
        for value in ("[]", [], 7, None):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    validate_score_profile(value)


if __name__ == "__main__":
    unittest.main()
