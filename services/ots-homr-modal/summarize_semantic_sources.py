"""Report pooled semantic development results separately for Lieder and OSSQ."""

import argparse
import json
import time
from pathlib import Path

from semantic_text_pilot import coverage, sha, write


def summarize(packet):
    records = json.loads((packet / "inventory.json").read_text())
    run = packet / "grouped-pilot"
    grouped = json.loads((run / "out-of-fold.json").read_text())
    report = json.loads((run / "report.json").read_text())
    grid = []
    for policy in report["selection_grid"]:
        observations = grouped[str(policy["lambda"])]["predictions"]
        decisions = []
        for row in observations:
            p, t = row["lyric_probability"], policy["threshold"]
            role = (
                "Unknown"
                if p is None
                else (
                    "Lyrics" if p >= t else "DirectionText" if p <= 1 - t else "Unknown"
                )
            )
            decisions.append({**row, "prediction": role})
        groups = {}
        for corpus in ["lieder", "ossq"]:
            refs = [
                r
                for r in records
                if r["development_split"] == "training-candidate"
                and r["score"].startswith("sq") == (corpus == "ossq")
            ]
            groups[corpus] = coverage(refs, decisions)
        grid.append(
            {
                "lambda": policy["lambda"],
                "threshold": policy["threshold"],
                "sources": groups,
            }
        )
    result = {
        "scope": "Training-score out-of-fold development only; OSSQ has no positive lyrics, so pooled performance is not adequate",
        "selected_policy": report["selected_policy"],
        "grid_by_source": grid,
        "inventory_sha256": sha(packet / "inventory.json"),
        "out_of_fold_sha256": sha(run / "out-of-fold.json"),
        "source_sha256": sha(__file__),
    }
    write(run / "source-report.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    if args.wait:
        while not (args.packet / "exit-code.json").exists():
            time.sleep(10)
        if json.loads((args.packet / "exit-code.json").read_text())["exitCode"]:
            raise SystemExit("OCR/grouped pilot failed; no source results claimed")
    summarize(args.packet)
    print("Per-source development report written")
