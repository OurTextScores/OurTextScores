"""Compare hash-bound filter inventories; no attachment or genuine-lyric recall claim."""

import argparse
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_inventory(folder, record):
    path = folder / f"{record['score']}_{record['id'].split(':')[-1]}.json"
    if sha(path) != record["inventorySha256"]:
        raise ValueError(f"Inventory changed: {path}")
    return {row["id"]: row for row in json.loads(path.read_text())["ocrRows"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("corrected", type=Path)
    parser.add_argument("fusion", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    baseline = json.loads((args.baseline / "report.json").read_text())
    corrected = json.loads((args.corrected / "report.json").read_text())
    for key in ["fusionSha256", "ocrSha256"]:
        if baseline[key] != corrected[key]:
            raise ValueError(f"Replay inputs differ: {key}")
    if sha(args.fusion) != baseline["fusionSha256"]:
        raise ValueError("Fusion snapshot changed")
    corpus = {
        row["id"]: row["corpus"]
        for row in map(json.loads, args.fusion.read_text().splitlines())
    }
    before = {row["id"]: row for row in baseline["pages"]}
    after = {row["id"]: row for row in corrected["pages"]}
    if before.keys() != after.keys():
        raise ValueError("Page sets differ")
    totals = {}
    pages = []
    for page_id, a in before.items():
        b = after[page_id]
        if a["status"] != "replayed" or b["status"] != "replayed":
            raise ValueError(f"Incomplete replay: {page_id}")
        old = load_inventory(args.baseline, a)
        new = load_inventory(args.corrected, b)
        if old.keys() != new.keys():
            raise ValueError(f"OCR row identities differ: {page_id}")
        changed = []
        for row_id, row in old.items():
            next_row = new[row_id]
            fields = ["anchor", "proposedLyric", "withheldReason"]
            if any(row.get(k) != next_row.get(k) for k in fields):
                changed.append(
                    {
                        "id": row_id,
                        "text": row["text"],
                        "before": {k: row.get(k) for k in fields},
                        "after": {k: next_row.get(k) for k in fields},
                    }
                )
        label = corpus[page_id]
        counts = totals.setdefault(
            label,
            {
                "pages": 0,
                "inputProposals": 0,
                "baselineRetained": 0,
                "correctedRetained": 0,
                "changedRows": 0,
            },
        )
        for key, value in [
            ("pages", 1),
            ("inputProposals", a["inputProposals"]),
            ("baselineRetained", a["retainedProposals"]),
            ("correctedRetained", b["retainedProposals"]),
            ("changedRows", len(changed)),
        ]:
            counts[key] += value
        pages.append(
            {
                "id": page_id,
                "corpus": label,
                "score": a["score"],
                "changedRows": changed,
                "baselineRetained": a["retainedProposals"],
                "correctedRetained": b["retainedProposals"],
                "survivingOssqProposals": [
                    {"id": r["id"], "text": r["text"], "box": r["box"]}
                    for r in new.values()
                    if label == "ossq" and r["proposedLyric"]
                ],
            }
        )
    args.out.mkdir(parents=True, exist_ok=True)
    report = {
        "scope": "Same-input anchor/filter comparison. OSSQ pages are scan-verified lyric-free controls: retained proposals are false lyric suggestions, not automatic attachments. Counts do not measure genuine-lyric recall or correct note placement.",
        "totals": totals,
        "pages": pages,
        "inputSha256": {
            "runner": sha(Path(__file__)),
            "baselineReport": sha(args.baseline / "report.json"),
            "correctedReport": sha(args.corrected / "report.json"),
            "fusion": sha(args.fusion),
        },
    }
    (args.out / "comparison.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    )
    lines = [
        "# Baseline versus corrected lyric anchors",
        "",
        report["scope"],
        "",
        "| Corpus | Pages | Semantic proposals | Baseline retained | Corrected retained | Changed rows |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for label, counts in totals.items():
        lines.append(
            f"| {label} | {counts['pages']} | {counts['inputProposals']} | "
            f"{counts['baselineRetained']} | {counts['correctedRetained']} | "
            f"{counts['changedRows']} |"
        )
    lines += ["", "## Surviving OSSQ lyric suggestions", ""]
    survivors = [
        (page["id"], row) for page in pages for row in page["survivingOssqProposals"]
    ]
    for page_id, row in survivors:
        text = row["text"].replace("\n", " ")
        lines.append(f"- {page_id}: {text!r}, box {row['box']}, ID {row['id']}.")
    if not survivors:
        lines.append("None in the replayed OSSQ controls.")
    lines += [
        "",
        "Full changed anchors and report/input hashes are recorded in comparison.json.",
        "Zero surviving control proposals does not prove zero errors on unseen scores.",
        "The approved 95% conditional retention gate still requires genuine lyric reference matches.",
    ]
    (args.out / "README.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
