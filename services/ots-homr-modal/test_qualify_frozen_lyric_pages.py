import hashlib
import json

import pytest
from qualify_frozen_lyric_pages import inventory, verify_page


def test_frozen_page_and_detector_identity_are_required(tmp_path):
    image = tmp_path / "image.png"
    image.write_bytes(b"frozen raster")
    page = {
        "id": "page:123",
        "image": str(image),
        "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
    }
    detection = {
        **page,
        "boxes": [
            {"box": [0, 0, 10, 10], "rawConfidence": 0.5},
            {"box": [2, 2, 3, 3], "rawConfidence": 0.49},
        ],
    }
    assert verify_page(page, detection) == [[0, 0, 10, 10]]
    with pytest.raises(ValueError, match="identity mismatch"):
        verify_page(page, {**detection, "image_sha256": "different"})
    image.write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum mismatch"):
        verify_page(page, detection)


def test_duplicate_cache_inventory_fails_closed(tmp_path):
    path = tmp_path / "rows.jsonl"
    row = json.dumps({"id": "page:123"})
    path.write_text(row + "\n" + row + "\n")
    with pytest.raises(ValueError, match="duplicate page ID"):
        inventory([path])
