from preflight_tremolo_private_candidate import preflight


def test_missing_inputs_fail_verification(tmp_path):
    result = preflight(tmp_path)
    assert len(result["files"]) == 8
    assert all(not row["verified"] for row in result["files"].values())
    assert result["sourceSha256"]
    assert result["pinsSha256"]
    assert result["sessions"] == {}


def test_tampered_existing_graph_does_not_verify(tmp_path):
    path = tmp_path / "jhlusko--OTS-homr/encoder.onnx"
    path.parent.mkdir()
    path.write_bytes(b"not-the-pinned-encoder")
    result = preflight(tmp_path)
    assert result["files"]["encoder"]["actualSha256"]
    assert not result["files"]["encoder"]["verified"]
