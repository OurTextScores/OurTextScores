"""Validate explicit placement decisions against frozen runtime evidence."""

import argparse
import json
from copy import deepcopy
from pathlib import Path


def placement_handoff(inventory, review):
    review = deepcopy(review)
    if review.get("schemaVersion") == "ots.lyric-placement-decisions.v2":
        lines = {}
        for row in inventory:
            lines.setdefault(row["score"], set()).add(row["physicalRowOrder"])
        for decision in review["decisions"]:
            line = decision.get("printedLine")
            if line is not None and (
                type(line) is not int or line not in lines.get(decision["score"], set())
            ):
                raise ValueError("Unknown printed lyric line")
            if line is None and decision["verseConfirmed"]:
                raise ValueError("Confirmed lyric line is missing")
            decision["verse"] = "" if line is None else f"printed-line-{line}"
        review["schemaVersion"] = "ots.lyric-placement-decisions.v1"
    if (
        review.get("schemaVersion") != "ots.lyric-placement-decisions.v1"
        or review.get("automaticAttachment") is not False
    ):
        raise ValueError("Unsupported or automatic placement review")
    originals = {r["id"]: r for r in inventory}
    decisions = review["decisions"]
    if (
        len(originals) != len(inventory)
        or len({d["id"] for d in decisions}) != len(decisions)
        or {d["id"] for d in decisions} != set(originals)
    ):
        raise ValueError("Missing, duplicate or unknown placement")
    confirmed, pending, excluded = [], [], []
    for d in decisions:
        r = originals[d["id"]]
        for key in (
            "score",
            "pageSha256",
            "musicXmlSha256",
            "generatedNote",
            "predictions_sha256",
        ):
            if d[key] != r[key]:
                raise ValueError("Frozen placement evidence differs")
        for key in ("textConfirmed", "verseConfirmed", "noteConfirmed", "excluded"):
            if type(d[key]) is not bool:
                raise ValueError("Confirmation must be boolean")
        if not isinstance(d["text"], str) or not isinstance(d["verse"], str):
            raise TypeError("Invalid text or verse")
        if (
            d["textConfirmed"]
            and not d["text"].strip()
            or d["verseConfirmed"]
            and not d["verse"].strip()
        ):
            raise ValueError("Empty confirmed text or verse")
        if d["noteConfirmed"] and d["text"] != r["text"]:
            raise ValueError("Edited text requires fresh positioning")
        row = dict(d, positionRefreshRequired=d["text"] != r["text"])
        if d["excluded"]:
            excluded.append(row)
        elif all(d[k] for k in ("textConfirmed", "verseConfirmed", "noteConfirmed")):
            confirmed.append(row)
        else:
            pending.append(row)
    return {
        "schemaVersion": "ots.lyric-placement-plan.v1",
        "automaticAttachment": False,
        "musicXmlModified": False,
        "confirmedPlacements": confirmed,
        "pendingPlacements": pending,
        "excludedPlacements": excluded,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = placement_handoff(
        json.loads(args.inventory.read_text()), json.loads(args.review.read_text())
    )
    with args.out.open("x") as handle:
        json.dump(result, handle, indent=2)
