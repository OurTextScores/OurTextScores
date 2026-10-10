"""Slurs against the native OpenScore source, with and without markup_repair.

Each page's parts are aligned to the native score (engine_vs_native.align); slurs are paired by number within a part as MusicXML
defines (what a renderer draws) and compared with the native slurs by start and stop measure. Reports precision and
recall for OTS-HOMR as written, OTS-HOMR repaired and HOMR as written.
"""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from engine_vs_native import parse_rhythm_parts
from markup_repair import repair_musicxml
from score_direction_placement import SOURCES, align, fetch, native_candidates


def slur_pairs(root):
    """Per part: the slurs as MusicXML defines them (start and stop matched by number within the part), as
    (start measure, stop measure) tuples; unmatched marks are ignored, as a renderer ignores them or mis-draws them."""
    parts = []
    for part in root.iter("part"):
        open_, pairs = {}, []
        for m_index, measure in enumerate(part.findall("measure")):
            for note in measure.findall("note"):
                if note.find("chord") is not None:
                    continue
                for slur in note.iter("slur"):
                    number = slur.get("number") or "1"
                    if slur.get("type") == "start":
                        open_[number] = m_index
                    elif slur.get("type") == "stop" and number in open_:
                        pairs.append((open_.pop(number), m_index))
        parts.append(pairs)
    return parts


def compare(root, natives):
    """(our slurs, of which match a native slur by start and stop measure, native slurs in the window, found)."""
    rhythm, slurs = parse_rhythm_parts(root), slur_pairs(root)
    best = None
    for native_root in natives:
        n_rhythm, n_slurs = parse_rhythm_parts(native_root), slur_pairs(native_root)
        for i, part in enumerate(rhythm):
            for j, native in enumerate(n_rhythm):
                start, score = align(part, native)
                if score >= 0.7 and (best is None or score > best[0]):
                    best = (score, slurs[i], n_slurs[j], start, len(part))
    if best is None:
        return None
    _, mine, theirs, start, length = best
    window = {(a - start, b - start) for a, b in theirs if start <= a and b < start + length}
    ours = len(mine)
    matched = sum(1 for pair in mine if pair in window)
    found = len(window & set(mine))
    return ours, matched, len(window), found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--homr-xml", type=Path, required=True)
    parser.add_argument("--exclude", default="")
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    skip = set(filter(None, args.exclude.split(",")))
    totals = {k: [0, 0, 0, 0] for k in ("ots", "otsRepaired", "homr")}
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
        if page in skip or not (args.homr_xml / f"{page}.musicxml").exists():
            continue
        natives = [root for _, root in native_candidates(score, catalogue)]
        raw = fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token)
        results = {"ots": compare(ET.fromstring(raw), natives), "otsRepaired": compare(ET.fromstring(repair_musicxml(raw)[0]), natives), "homr": compare(ET.parse(args.homr_xml / f"{page}.musicxml").getroot(), natives)}
        if all(results.values()):
            for k, v in results.items():
                for i in range(4):
                    totals[k][i] += v[i]
    summary = {k: {"slursWritten": v[0], "matchNative": v[1], "precision": round(v[1] / v[0], 4), "nativeSlurs": v[2], "found": v[3], "recall": round(v[3] / v[2], 4)} for k, v in totals.items()}
    args.out.write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
