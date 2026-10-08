from audit_detector_training_membership import is_valid, membership


def test_hash_split_matches_homr_detector_split():
    # Same formula as training/ocr/detector_split.is_valid (seed 0, fraction 0.1).
    assert is_valid("IMSLP10602") in (True, False)
    flags = [is_valid(f"IMSLP{i}") for i in range(2000)]
    assert 0.07 < sum(flags) / len(flags) < 0.13


def test_membership_categories():
    valid = next(f"S{i}" for i in range(500) if is_valid(f"S{i}"))
    train = next(f"S{i}" for i in range(500) if not is_valid(f"S{i}"))
    pool = {valid, train}
    assert membership("X", "lieder", pool) == "clean-not-in-pool"
    assert membership(valid, "lieder", pool) == "clean-hash-valid"
    assert membership(train, "lieder", pool) == "possibly-trained"
    assert membership(train, "ossq", pool) == "ossq-unverified"
