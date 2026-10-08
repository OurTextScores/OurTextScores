import copy

import pytest
from prepare_semantic_gt_packet import select_regions


def fixture_pages():
    return [
        {
            "partition": "calibration",
            "corpus": "lieder",
            "score": score,
            "id": score + ":page",
            "ground_truth": [
                {"semanticFamily": role, "box": [i, 0, i + 1, 1], "evidence": []}
                for i, role in enumerate(
                    [
                        "DirectionText",
                        "DirectionText",
                        "Lyrics",
                        "Lyrics",
                        "Lyrics",
                        "Dynamic",
                    ]
                )
            ],
        }
        for score in ("a", "b", "excluded")
    ]


def audit():
    return {
        "excluded_scores": ["excluded"],
        "selected_page_ids": ["a:page", "b:page"],
        "candidate_pages": 2,
    }


def test_complete_directions_bounded_lyrics_no_inferred_negatives():
    pages = fixture_pages()
    before = copy.deepcopy(pages)
    selected = select_regions(pages, audit())
    assert pages == before
    assert len(selected) == 8
    assert (
        sum(r["ground_truth"]["semanticFamily"] == "DirectionText" for r in selected)
        == 4
    )
    assert {r["ground_truth"]["semanticFamily"] for r in selected} == {
        "Lyrics",
        "DirectionText",
    }
    assert {r["page"]["score"] for r in selected} == {"a", "b"}
    assert selected == select_regions(pages, audit())
    for score in ("a", "b"):
        assert len({r["split"] for r in selected if r["page"]["score"] == score}) == 1


def test_no_test_pages_or_excluded_membership():
    pages = fixture_pages()
    pages[0]["partition"] = "test"
    with pytest.raises(ValueError, match="calibration"):
        select_regions(pages, audit())
    broken = audit()
    broken["selected_page_ids"] = ["a:page", "excluded:page"]
    with pytest.raises(ValueError, match="membership"):
        select_regions(fixture_pages(), broken)
