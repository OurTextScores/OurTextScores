"""Conservative lexical reference links for review; never a certified recall gate."""

import argparse
import hashlib
import json
import unicodedata
from collections import defaultdict
from pathlib import Path


def text_key(text):
    return "".join(
        c for c in unicodedata.normalize("NFC", text).casefold() if c.isalnum()
    )


def possible_matches(text, targets, start_measure, end_measure):
    """Whole OCR row against consecutive source syllables, without fuzzy matching."""
    key = text_key(text)
    if not key:
        return []
    groups = defaultdict(list)
    for target in targets:
        value = target["target"]
        if start_measure <= value["physical_measure"] <= end_measure:
            groups[(value["source_part"], value["verse"])].append(target)
    matches = []
    for group in groups.values():
        group.sort(
            key=lambda t: (
                t["target"]["physical_measure"],
                t["target"]["source_note_ordinal"],
            )
        )
        for start in range(len(group)):
            combined = ""
            for stop in range(start, min(len(group), start + 16)):
                combined += text_key(group[stop]["target"]["text"])
                if combined == key:
                    matches.append([t["targetId"] for t in group[start : stop + 1]])
                if len(combined) >= len(key):
                    break
    return matches


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    replay = args.base / "lyric-prepared-full25-20261008"
    inputs = [
        replay / "pages.json",
        replay / "preparation.json",
        replay / "native-target-ledger.json",
        args.base / "lyric-approved-native-links-20261008-v2/pages.json",
    ]
    prepared = json.loads(inputs[0].read_text())
    transforms = {
        t["preparedId"]: t for t in json.loads(inputs[1].read_text())["transforms"]
    }
    targets = json.loads(inputs[2].read_text())["targets"]
    approved = {p["id"]: p for p in json.loads(inputs[3].read_text())}
    records = []
    for page in prepared:
        if page["corpus"] != "lieder":
            continue
        transform = transforms[page["id"]]
        original = transform["originalId"]
        reference = approved[original]
        if sha(Path(reference["native_source"])) != reference["native_source_sha256"]:
            raise ValueError("Native source changed")
        inventory_path = (
            replay
            / "filtered"
            / (page["score"] + "_" + page["id"].split(":")[-1] + ".json")
        )
        inputs.append(inventory_path)
        rows = json.loads(inventory_path.read_text())["ocrRows"]
        sx = transform["originalSize"][0] / transform["preparedSize"][0]
        sy = transform["originalSize"][1] / transform["preparedSize"][1]
        page_targets = [t for t in targets if t["originalPageId"] == original]
        for row in rows:
            x = (row["box"][0] + row["box"][2]) / 2 * sx
            y = (row["box"][1] + row["box"][3]) / 2 * sy
            systems = [
                s
                for s in reference["systems"]
                if s["cropBox"][0] <= x <= s["cropBox"][2]
                and s["cropBox"][1] <= y <= s["cropBox"][3]
            ]
            matches = (
                possible_matches(
                    row["text"],
                    page_targets,
                    systems[0]["start_measure"],
                    systems[0]["end_measure"],
                )
                if len(systems) == 1
                else []
            )
            records.append(
                {
                    "pageId": page["id"],
                    "candidateId": row["id"],
                    "text": row["text"],
                    "box": row["box"],
                    "semantic": row["semantic"],
                    "retained": row["proposedLyric"],
                    "withheldReason": row.get("withheldReason"),
                    "systemIndex": systems[0]["index"] if len(systems) == 1 else None,
                    "possibleNativeMatches": matches,
                    "status": (
                        "unique-lexical-link"
                        if len(matches) == 1
                        else "ambiguous" if matches else "unmatched"
                    ),
                    "pixelLinkCertified": False,
                    "noteOwnershipCertified": False,
                }
            )
    usage = defaultdict(list)
    for row in records:
        if row["status"] == "unique-lexical-link":
            for target in row["possibleNativeMatches"][0]:
                usage[target].append(row)
    for owners in usage.values():
        if len(owners) > 1:
            for row in owners:
                row["status"] = "candidate-collision"
    counts = {
        status: sum(r["status"] == status for r in records)
        for status in [
            "unique-lexical-link",
            "ambiguous",
            "unmatched",
            "candidate-collision",
        ]
    }
    report = {
        "scope": "Development lexical matching within approved passage/system windows. Case, punctuation and whitespace normalized; no fuzzy matching. Unique links are review suggestions, not certified genuine lyric candidates or note ownership. Unmatched rows are not false positives; unmatched targets are not false negatives.",
        "releaseGatePassed": False,
        "counts": counts,
        "rows": records,
        "inputSha256": {str(p): sha(p) for p in inputs},
        "runnerSha256": sha(Path(__file__)),
    }
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    )
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
