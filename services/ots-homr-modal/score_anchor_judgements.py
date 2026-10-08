"""Score a complete frozen lyric-anchor review; unsure counts as wrong."""

import argparse
import hashlib
import json
from collections import Counter
from math import sqrt
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score_review(items, key, review):
    ids = [item["id"] for item in items]
    digest = hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest()
    if (
        review.get("schemaVersion") != "ots.lyric-anchor-judgements.v1"
        or review.get("itemsSha256") != digest
    ):
        raise ValueError("Review belongs to a different inventory")
    keyed = {row["id"]: row for row in key}
    judgements = review["judgements"]
    if (
        len(ids) != len(set(ids))
        or len(keyed) != len(key)
        or set(ids) != set(keyed)
        or set(ids) != set(judgements)
    ):
        raise ValueError("Missing, unknown or duplicate review items")
    if any(
        value not in ("correct", "wrong", "unsure") for value in judgements.values()
    ):
        raise ValueError("Invalid judgement")
    corrections = review.get("syllableCorrections", {})
    if not isinstance(corrections, dict):
        raise TypeError("Invalid correction map")
    validated_corrections = []
    for identity, correction in corrections.items():
        if identity not in keyed or not isinstance(correction, dict):
            raise ValueError("Unknown or malformed syllable correction")
        original = keyed[identity]
        if correction.get("originalText") != original.get("text"):
            raise ValueError("Corrected candidate evidence differs")
        text = correction.get("correctedText")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Corrected syllable is empty or invalid")
        validated_corrections.append(
            {
                "id": identity,
                "score": original["score"],
                "originalText": original["text"],
                "correctedText": text,
                "positionRefreshRequired": text != original["text"],
                "notePlacementConfirmed": False,
                "automaticAttachment": False,
            }
        )
    n = len(ids)
    if not n:
        raise ValueError("Empty review")
    counts = Counter(judgements.values())
    p, z = counts["correct"] / n, 1.6448536269514722
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    margin = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    pages = {}
    failures = []
    for item in key:
        state = judgements[item["id"]]
        page = pages.setdefault(
            item["score"], {"items": 0, "correct": 0, "wrongIncludingUnsure": 0}
        )
        page["items"] += 1
        page["correct" if state == "correct" else "wrongIncludingUnsure"] += 1
        if state != "correct":
            failures.append(dict(item, judgement=state))
    return {
        "schemaVersion": "ots.lyric-anchor-fresh-evaluation.v2",
        "items": n,
        "reviewedSyllableCorrections": validated_corrections,
        "pages": len(pages),
        "judgements": dict(counts),
        "unsureTreatedAsWrong": {
            "correct": counts["correct"],
            "wrong": n - counts["correct"],
            "accuracy": p,
            "wilson90": [center - margin, center + margin],
        },
        "perPage": pages,
        "failures": failures,
        "scope": "Frozen-rule sampled proposed lyric placements, <=12 per page; conditional correctness, not end-to-end lyric recall. Per-item Wilson interval does not account for within-page clustering.",
        "rulesRetunedOnThisSample": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("items", "key", "review", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    result = score_review(
        json.loads(args.items.read_text()),
        json.loads(args.key.read_text()),
        json.loads(args.review.read_text()),
    )
    result["inputSha256"] = {
        str(path): sha(path) for path in (args.items, args.key, args.review)
    }
    result["sourceSha256"] = sha(Path(__file__))
    with args.out.open("x") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(
        json.dumps(
            {
                k: result[k]
                for k in (
                    "items",
                    "pages",
                    "judgements",
                    "unsureTreatedAsWrong",
                    "perPage",
                )
            },
            indent=2,
        )
    )
