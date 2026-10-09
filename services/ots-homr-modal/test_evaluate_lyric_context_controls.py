import unittest

from evaluate_lyric_context_controls import reference_rectangle, reference_role


def ref(role, box):
    return {"ground_truth_role": role, "preparedBox": box}


class Roles(unittest.TestCase):
    def test_contained_row_has_positive_role(self):
        self.assertEqual(
            reference_role([2, 2, 8, 8], [ref("Lyrics", [0, 0, 10, 10])]), "Lyrics"
        )

    def test_unlabelled_and_partial_neighbour_are_unscored(self):
        self.assertIsNone(
            reference_role([20, 20, 30, 30], [ref("Lyrics", [0, 0, 10, 10])])
        )
        self.assertIsNone(
            reference_role([0, 0, 20, 10], [ref("Lyrics", [0, 0, 10, 10])])
        )

    def test_conflicting_roles_abstain(self):
        self.assertIsNone(
            reference_role(
                [2, 2, 8, 8],
                [ref("Lyrics", [0, 0, 10, 10]), ref("DirectionText", [0, 0, 10, 10])],
            )
        )

    def test_legacy_quadrilateral_normalizes_without_changing_rectangles(self):
        self.assertEqual(
            reference_rectangle([[2, 3], [12, 4], [11, 9], [1, 8]]), [1, 3, 12, 9]
        )
        self.assertEqual(reference_rectangle([1, 3, 12, 9]), [1, 3, 12, 9])
        with self.assertRaises(ValueError):
            reference_rectangle([1, 2, 3])

    def test_zero_area_abstains(self):
        self.assertIsNone(reference_role([2, 2, 2, 8], [ref("Lyrics", [0, 0, 10, 10])]))


if __name__ == "__main__":
    unittest.main()
