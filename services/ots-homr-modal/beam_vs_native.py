"""Level-1 beam agreement of two engines' page MusicXML with the native OpenScore source.

Each page's parts are aligned to the native score by pitch+duration (engine_vs_native.align); in every aligned
measure whose note count matches, each non-chord note's first-level beam state (begin/continue/end/none) is compared
with the native one. Rests and chord tones beyond the first are skipped. A coarse yardstick for engraving fidelity.
"""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from markup_repair import repair_musicxml
from engine_vs_native import parse_rhythm_parts
from score_direction_placement import SOURCES, align, fetch, native_candidates


def beam_parts(root):
    parts = []
    for part in root.iter("part"):
        measures = []
        for measure in part.findall("measure"):
            states = []
            for note in measure.findall("note"):
                if note.find("chord") is not None or note.find("rest") is not None:
                    continue
                first = [b.text for b in note.findall("beam") if b.get("number") == "1"]
                states.append(first[0] if first else "-")
            measures.append(states)
        parts.append(measures)
    return parts


def agreement(root, native_candidates_list):
    rhythm, beams = parse_rhythm_parts(root), beam_parts(root)
    best = None
    for native_root in native_candidates_list:
        native_rhythm, native_beams = parse_rhythm_parts(native_root), beam_parts(native_root)
        for i, part in enumerate(rhythm):
            for j, native in enumerate(native_rhythm):
                start, score = align(part, native)
                if score >= 0.7 and (best is None or score > best[0]):
                    best = (score, beams[i], native_beams[j], start)
    if best is None:
        return None
    _, mine, theirs, start = best
    total = agree = 0
    for k, states in enumerate(mine):
        if start + k >= len(theirs) or len(theirs[start + k]) != len(states):
            continue
        for a, b in zip(states, theirs[start + k]):
            total += 1
            agree += a == b
    return total, agree


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--upstream-autobeamed", type=Path, required=True, help="HOMR output after MuseScore default beaming")
    parser.add_argument("--exclude", default="")
    parser.add_argument("--repair", action="store_true", help="apply markup_repair to OTS-HOMR output first")
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    skip = set(filter(None, args.exclude.split(",")))
    rows = []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
        if page in skip:
            continue
        natives = [root for _, root in native_candidates(score, catalogue)]
        raw = fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token)
        if args.repair:
            raw, _ = repair_musicxml(raw)
        ours = agreement(ET.fromstring(raw), natives)
        file = args.upstream_autobeamed / f"{page}.xml"
        theirs = agreement(ET.parse(file).getroot(), natives) if file.exists() else None
        rows.append({"page": page, "ots": ours, "homrDefault": theirs})
    both = [r for r in rows if r["ots"] and r["homrDefault"]]
    summary = {
        "pages": len(both),
        "otsNotes": sum(r["ots"][0] for r in both), "otsAgree": sum(r["ots"][1] for r in both),
        "homrNotes": sum(r["homrDefault"][0] for r in both), "homrAgree": sum(r["homrDefault"][1] for r in both),
    }
    summary["otsShare"] = round(summary["otsAgree"] / summary["otsNotes"], 4)
    summary["homrShare"] = round(summary["homrAgree"] / summary["homrNotes"], 4)
    args.out.write_text(json.dumps({"summary": summary, "pages": rows}, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
