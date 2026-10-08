"""Validate explicit text review without treating it as confirmed note placement."""

import argparse
import json
from pathlib import Path

from semantic_external_controls import sha


def review_handoff(suggestions, review):
    if (
        suggestions.get("schemaVersion") != "ots.lyric-suggestion-review.v1"
        or review.get("schemaVersion") != "ots.lyric-review-decisions.v1"
    ):
        raise ValueError("Unsupported lyric review schema")
    if (
        suggestions.get("automaticAttachment") is not False
        or review.get("automaticAttachment") is not False
    ):
        raise ValueError("Text review cannot enable automatic attachment")
    if review.get("modelSha256") != suggestions.get("modelSha256"):
        raise ValueError("Review model identity differs")
    pages = {p["score"]: p for p in suggestions["pages"]}
    reviewed_pages = review["pages"]
    if (
        len(pages) != len(suggestions["pages"])
        or len({p["score"] for p in reviewed_pages}) != len(reviewed_pages)
        or {p["score"] for p in reviewed_pages} != set(pages)
    ):
        raise ValueError("Review pages are missing, duplicate or unknown")
    accepted, excluded, pending = [], [], []
    for page in reviewed_pages:
        expected = pages[page["score"]]
        if page["imageSha256"] != expected["imageSha256"]:
            raise ValueError("Original page image identity differs")
        candidates = {r["id"]: r for r in expected["suggestions"]}
        decisions = page["decisions"]
        if (
            len(candidates) != len(expected["suggestions"])
            or len({r["id"] for r in decisions}) != len(decisions)
            or {r["id"] for r in decisions} != set(candidates)
        ):
            raise ValueError("Review candidates are missing, duplicate or unknown")
        for decision in decisions:
            original = candidates[decision["id"]]
            if (
                decision["box"] != original["box"]
                or decision["originalText"] != original["ocrText"]
                or decision["proposed"] is not original["proposed"]
            ):
                raise ValueError("Original candidate evidence differs")
            state = decision["decision"]
            text = decision["text"]
            if state not in ("pending", "accept", "exclude") or not isinstance(
                text, str
            ):
                raise ValueError("Invalid review decision/text")
            row = {
                "id": original["id"],
                "score": page["score"],
                "imageSha256": page["imageSha256"],
                "box": original["box"],
                "originalText": original["ocrText"],
                "reviewedText": text,
                "semanticProposed": original["proposed"],
                "decision": state,
            }
            if state == "accept":
                if not text.strip():
                    raise ValueError("Accepted lyric text is empty")
                row.update(
                    {
                        "textConfirmation": "explicit-human-review",
                        "placementStatus": "pending-verse-note-placement",
                        "positionRefreshRequired": text != original["ocrText"],
                        "verseConfirmed": False,
                        "notePlacementConfirmed": False,
                    }
                )
                accepted.append(row)
            elif state == "exclude":
                excluded.append(row)
            else:
                pending.append(row)
    return {
        "schemaVersion": "ots.lyric-review-handoff.v1",
        "modelSha256": suggestions["modelSha256"],
        "automaticAttachment": False,
        "musicXmlModified": False,
        "attachments": [],
        "acceptedText": accepted,
        "excludedText": excluded,
        "pendingText": pending,
        "counts": {
            "acceptedText": len(accepted),
            "excludedText": len(excluded),
            "pendingText": len(pending),
            "confirmedNotePlacements": 0,
            "positionRefreshRequired": sum(
                r["positionRefreshRequired"] for r in accepted
            ),
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suggestions", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = review_handoff(
        json.loads(args.suggestions.read_text()), json.loads(args.review.read_text())
    )
    result["provenance"] = {
        "suggestionsSha256": sha(args.suggestions),
        "reviewSha256": sha(args.review),
        "sourceSha256": sha(Path(__file__)),
    }
    with args.out.open("x") as handle:
        handle.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(result["counts"], indent=2))
