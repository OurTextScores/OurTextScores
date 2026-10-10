"""Compare e2 Lyrics detections made with two confidence extractions over the same calibration pages.

Reports whether geometry is identical (the extraction fix must not move a box), how many raw confidences changed and by
how much, and which boxes cross a calibration band edge or the accept line. The judged sample items are tracked
separately because they decide each band's lyric rate.
"""

import argparse
import json
from pathlib import Path

EDGES = [0.5, 0.6, 0.7, 0.8, 0.9]
ACCEPT_RAW = 0.7


def load(directory):
    pages = {}
    for path in sorted(Path(directory).glob("detections-*.jsonl")):
        for line in path.read_text().splitlines():
            page = json.loads(line)
            pages[page["id"]] = page
    return pages


def band(raw):
    index = -1
    for i, edge in enumerate(EDGES):
        if raw >= edge:
            index = i
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--sample-key", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    old, new = load(args.old), load(args.new)
    key = {r["id"]: r for r in json.loads(args.sample_key.read_text())}
    report = {"pages": {"old": len(old), "new": len(new), "common": len(set(old) & set(new))}, "geometryMismatchPages": [], "boxes": 0, "changed": 0, "deltas": [], "bandTransitions": 0, "acceptTransitions": 0, "transitions": [], "judgedItems": len(key), "judgedChanged": 0, "judgedBandMoves": 0}
    judged_boxes = {tuple(r.get("box") or ()) for r in key.values()}
    for page_id in sorted(set(old) & set(new)):
        a, b = old[page_id]["boxes"], new[page_id]["boxes"]
        if [x["box"] for x in a] != [x["box"] for x in b]:
            report["geometryMismatchPages"].append({"id": page_id, "old": len(a), "new": len(b)})
            continue
        for x, y in zip(a, b):
            report["boxes"] += 1
            delta = y["rawConfidence"] - x["rawConfidence"]
            if abs(delta) > 1e-9:
                report["changed"] += 1
                report["deltas"].append(delta)
            if band(x["rawConfidence"]) != band(y["rawConfidence"]):
                report["bandTransitions"] += 1
                report["transitions"].append({"page": page_id, "box": x["box"], "old": x["rawConfidence"], "new": y["rawConfidence"], "corpus": old[page_id]["corpus"]})
            if (x["rawConfidence"] >= ACCEPT_RAW) != (y["rawConfidence"] >= ACCEPT_RAW):
                report["acceptTransitions"] += 1
    deltas = sorted(report.pop("deltas"))
    if deltas:
        report["deltaSummary"] = {"min": deltas[0], "p05": deltas[int(0.05 * len(deltas))], "median": deltas[len(deltas) // 2], "p95": deltas[int(0.95 * len(deltas)) - 1], "max": deltas[-1], "meanAbs": sum(abs(d) for d in deltas) / len(deltas)}
    args.out.write_text(json.dumps(report, indent=1))
    print({k: v for k, v in report.items() if k not in ("transitions", "geometryMismatchPages")})
    print("geometry mismatch pages:", len(report["geometryMismatchPages"]))


if __name__ == "__main__":
    main()
