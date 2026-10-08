import copy

import pytest
from lyric_review_handoff import review_handoff


def packet():
    suggestions = {
        "schemaVersion": "ots.lyric-suggestion-review.v1",
        "automaticAttachment": False,
        "modelSha256": "model",
        "pages": [
            {
                "score": "s",
                "imageSha256": "image",
                "suggestions": [
                    {
                        "id": "a",
                        "box": [1, 2, 3, 4],
                        "ocrText": "an.",
                        "proposed": False,
                    }
                ],
            }
        ],
    }
    review = {
        "schemaVersion": "ots.lyric-review-decisions.v1",
        "automaticAttachment": False,
        "modelSha256": "model",
        "pages": [
            {
                "score": "s",
                "imageSha256": "image",
                "decisions": [
                    {
                        "id": "a",
                        "box": [1, 2, 3, 4],
                        "originalText": "an.",
                        "proposed": False,
                        "text": "an",
                        "decision": "accept",
                    }
                ],
            }
        ],
    }
    return suggestions, review


def test_explicit_review_can_recover_withheld_text_but_never_confirms_placement():
    suggestions, review = packet()
    before = copy.deepcopy((suggestions, review))
    result = review_handoff(suggestions, review)
    assert result["counts"]["acceptedText"] == 1
    assert result["acceptedText"][0]["positionRefreshRequired"] is True
    assert result["acceptedText"][0]["verseConfirmed"] is False
    assert result["acceptedText"][0]["notePlacementConfirmed"] is False
    assert result["attachments"] == []
    assert result["automaticAttachment"] is False
    assert (suggestions, review) == before


@pytest.mark.parametrize("state", ["pending", "exclude"])
def test_only_explicit_acceptance_enters_text_handoff(state):
    suggestions, review = packet()
    review["pages"][0]["decisions"][0]["decision"] = state
    assert review_handoff(suggestions, review)["acceptedText"] == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(modelSha256="other"),
        lambda r: r.update(automaticAttachment=True),
        lambda r: r["pages"][0].update(imageSha256="other"),
        lambda r: r["pages"][0]["decisions"][0].update(originalText="forged"),
        lambda r: r["pages"][0]["decisions"][0].update(id="other"),
        lambda r: r["pages"][0]["decisions"][0].update(text=" "),
        lambda r: r["pages"][0]["decisions"].append(
            copy.deepcopy(r["pages"][0]["decisions"][0])
        ),
    ],
)
def test_stale_forged_duplicate_or_empty_acceptance_rejected(mutation):
    suggestions, review = packet()
    mutation(review)
    with pytest.raises(ValueError):
        review_handoff(suggestions, review)
