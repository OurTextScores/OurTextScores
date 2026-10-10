"""Beam agreement with the native score on the notes that can carry a beam, after MuseScore has applied its own
beaming wherever a file leaves it open.

Three readings of each page are each round-tripped through MuseScore (so a note with no <beam> is beamed by the
editor's default, which is what a user sees): OTS-HOMR as written, OTS-HOMR after markup_repair, and HOMR. Only notes
of eighth or shorter value in the native score are compared, on their first-level beam state, in measures whose note
count matches. Reports pooled and per-page agreement.
"""

import argparse
import json
import os
import statistics
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from engine_vs_native import parse_rhythm_parts
from markup_repair import repair_musicxml
from score_direction_placement import SOURCES, align, fetch, native_candidates

BEAMABLE = {"eighth", "16th", "32nd", "64th", "128th", "256th"}
HERE = Path(__file__).resolve().parent / "overlay"


def roundtrip(node, modules, data: bytes, directory: Path, name: str) -> ET.Element:
    source, out = directory / f"{name}.in.xml", directory / f"{name}.out.xml"
    source.write_bytes(data)
    env = dict(os.environ, NODE_PATH=str(modules))
    subprocess.run([node, "-r", str(HERE / "nonav.cjs"), str(HERE / "normalize.cjs"), str(source), str(out)], check=True, env=env, timeout=300)
    return ET.parse(out).getroot()


def note_states(root):
    parts = []
    for part in root.iter("part"):
        measures = []
        for measure in part.findall("measure"):
            states = []
            for note in measure.findall("note"):
                if note.find("chord") is not None or note.find("rest") is not None:
                    continue
                first = [b.text for b in note.findall("beam") if b.get("number") == "1"]
                states.append((first[0] if first else "-", note.findtext("type")))
            measures.append(states)
        parts.append(measures)
    return parts


def triples(readings, natives):
    """Per beamable native note in measures where all readings have the same note count: (native, ots, homr) beam states."""
    parsed = {k: (parse_rhythm_parts(r), note_states(r)) for k, r in readings.items()}
    best = None
    for native_root in natives:
        n_rhythm, n_states = parse_rhythm_parts(native_root), note_states(native_root)
        for j, native in enumerate(n_rhythm):
            found = {}
            for key, (rhythm, states) in parsed.items():
                for i, part in enumerate(rhythm):
                    start, score = align(part, native)
                    if score >= 0.7 and (key not in found or score > found[key][0]):
                        found[key] = (score, states[i], start)
            if len(found) == len(parsed) and (best is None or sum(v[0] for v in found.values()) > best[0]):
                best = (sum(v[0] for v in found.values()), found, n_states[j])
    if best is None:
        return []
    _, found, theirs = best
    out = []
    for k, native_measure in enumerate(theirs):
        rows = {key: (val[1][k - val[2]] if 0 <= k - val[2] < len(val[1]) else None) for key, val in found.items()}
        if any(v is None for v in rows.values()) or any(len(v) != len(native_measure) for v in rows.values()):
            continue
        for index, (state, kind) in enumerate(native_measure):
            if kind in BEAMABLE:
                out.append((state, rows["ots"][index][0], rows["homr"][index][0]))
    return out


def agreement(root, natives):
    rhythm, states = parse_rhythm_parts(root), note_states(root)
    best = None
    for native_root in natives:
        n_rhythm, n_states = parse_rhythm_parts(native_root), note_states(native_root)
        for i, part in enumerate(rhythm):
            for j, native in enumerate(n_rhythm):
                start, score = align(part, native)
                if score >= 0.7 and (best is None or score > best[0]):
                    best = (score, states[i], n_states[j], start)
    if best is None:
        return None
    _, mine, theirs, start = best
    total = agree = 0
    for k, measure in enumerate(mine):
        if start + k >= len(theirs) or len(theirs[start + k]) != len(measure):
            continue
        for (a, _), (b, kind) in zip(measure, theirs[start + k]):
            if kind in BEAMABLE:
                total += 1
                agree += a == b
    return total, agree


def who_is_right(args):
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    skip = set(filter(None, args.exclude.split(",")))
    totals = {"notes": 0, "agree": 0, "differ": 0, "ots right": 0, "homr right": 0, "neither": 0}
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        for line in args.jobs.read_text().splitlines():
            job = json.loads(line)
            page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
            if page in skip or not (args.homr_xml / f"{page}.musicxml").exists():
                continue
            natives = [root for _, root in native_candidates(score, catalogue)]
            raw = fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token)
            readings = {"ots": roundtrip(args.node, args.modules, repair_musicxml(raw)[0], directory, "ots"), "homr": roundtrip(args.node, args.modules, (args.homr_xml / f"{page}.musicxml").read_bytes(), directory, "homr")}
            for native, ots, homr in triples(readings, natives):
                totals["notes"] += 1
                if ots == homr:
                    totals["agree"] += 1
                    continue
                totals["differ"] += 1
                totals["ots right" if ots == native else "homr right" if homr == native else "neither"] += 1
    print(json.dumps(totals))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--homr-xml", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--exclude", default="")
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    parser.add_argument("--who-is-right", action="store_true")
    args = parser.parse_args()
    if args.who_is_right:
        return who_is_right(args)
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    skip = set(filter(None, args.exclude.split(",")))
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        for line in args.jobs.read_text().splitlines():
            job = json.loads(line)
            page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
            if page in skip or not (args.homr_xml / f"{page}.musicxml").exists():
                continue
            natives = [root for _, root in native_candidates(score, catalogue)]
            raw = fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token)
            readings = {
                "ots": raw,
                "otsRepaired": repair_musicxml(raw)[0],
                "otsKeepGroups": repair_musicxml(raw, beam_groups=False)[0],
                "otsNoBeamEdit": None,
                "homr": (args.homr_xml / f"{page}.musicxml").read_bytes(),
            }
            result = {name: agreement(roundtrip(args.node, args.modules, data, directory, name), natives) for name, data in readings.items() if data is not None}
            rows.append({"page": page, **result})
            print(page, result, flush=True)
    good = [r for r in rows if all(r.get(k) and r[k][0] >= 8 for k in ("ots", "otsRepaired", "otsKeepGroups", "homr"))]
    summary = {"pages": len(good)}
    for k in ("ots", "otsRepaired", "otsKeepGroups", "homr"):
        summary[k] = {"notes": sum(r[k][0] for r in good), "agree": sum(r[k][1] for r in good), "medianPerPage": round(statistics.median(r[k][1] / r[k][0] for r in good), 3)}
        summary[k]["pooled"] = round(summary[k]["agree"] / summary[k]["notes"], 3)
    summary["repairedCloser"] = sum(1 for r in good if r["otsRepaired"][1] / r["otsRepaired"][0] > r["homr"][1] / r["homr"][0] + 0.05)
    summary["homrCloser"] = sum(1 for r in good if r["homr"][1] / r["homr"][0] > r["otsRepaired"][1] / r["otsRepaired"][0] + 0.05)
    args.out.write_text(json.dumps({"summary": summary, "pages": rows}, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
