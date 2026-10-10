"""Rank the individual printed lines (systems) of a pool by how much better OTS-HOMR reads them than HOMR does.

Each page is cut at the scan's own system breaks (<print new-system>). For every line and every engine, each part's
measures are compared with the encoded score's measures at the offset where that part best aligns (pitch, duration and
rests, SequenceMatcher per measure, as engine_vs_native.align does), and the line score is the average over the parts.
Only lines that exist in both readings, and whose parts align to the encoded score, are ranked.
"""

import argparse
import difflib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine_vs_native import parse_rhythm_parts
from lines import system_ranges
from markup_repair import repair_musicxml
from score_direction_placement import SOURCES, align, fetch, native_candidates

MIN_ALIGNMENT = 0.6


def measure_similarity(a, b):
    ta, tb = a["pitches"], b["pitches"]
    return 1.0 if not ta and not tb else difflib.SequenceMatcher(None, ta, tb).ratio()


def part_alignments(root, natives):
    """For each page part: (native part measures, start offset, alignment) of its best match, or None."""
    native_parts = [(nr, parse_rhythm_parts(nr)) for _, nr in natives]
    out = []
    for part in parse_rhythm_parts(root):
        best = None
        for _, parts in native_parts:
            for native in parts:
                if not native or not part:
                    continue
                start, score = align(part, native)
                if best is None or score > best[2]:
                    best = (native, start, score)
        out.append(best if best and best[2] >= MIN_ALIGNMENT else None)
    return out


def line_scores(root, natives):
    parts = parse_rhythm_parts(root)
    aligned = part_alignments(root, natives)
    page_parts = root.findall("part")
    scores = []
    for index in range(max(len(system_ranges(p)) for p in page_parts)):
        values = []
        for part, link, element in zip(parts, aligned, page_parts):
            ranges = system_ranges(element)
            if link is None or index >= len(ranges):
                continue
            native, start, _ = link
            a, b = ranges[index]
            sims = [measure_similarity(part[k], native[start + k]) for k in range(a, b) if k < len(part) and start + k < len(native)]
            if sims:
                values.append(sum(sims) / len(sims))
        scores.append({"score": sum(values) / len(values), "parts": len(values)} if values else None)
    return scores


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--homr-xml", type=Path, required=True)
    parser.add_argument("--ossq-native", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    ossq_cache, lines = {}, []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        page = Path(job["image"]).stem
        score = page.split("-")[0]
        homr_file = args.homr_xml / f"{page}.musicxml"
        if not homr_file.exists():
            continue
        if score.startswith("sq"):
            if score not in ossq_cache:
                ossq_cache[score] = [(score, ET.parse(args.ossq_native / f"{score}.musicxml").getroot())]
            natives, kind = ossq_cache[score], "quartet"
        else:
            natives, kind = list(native_candidates(score, catalogue)), "song"
        if not natives:
            continue
        ots_root = ET.fromstring(repair_musicxml(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token), drop_beams=True)[0])
        homr_root = ET.parse(homr_file).getroot()
        ots_lines, homr_lines = line_scores(ots_root, natives), line_scores(homr_root, natives)
        if len(ots_lines) != len(homr_lines):
            print(page, "the two readings break into different numbers of lines; skipped", flush=True)
            continue
        for index, (o, h) in enumerate(zip(ots_lines, homr_lines)):
            if o and h:
                lines.append({"page": page, "line": index + 1, "id": f"{page}-L{index + 1}", "kind": kind, "jobId": job["jobId"], "ots": round(o["score"], 4), "homr": round(h["score"], 4), "gain": round(o["score"] - h["score"], 4), "parts": o["parts"]})
        print(page, kind, len(ots_lines), "lines", flush=True)
    lines.sort(key=lambda r: (-r["gain"], r["id"]))
    summary = {"lines": len(lines)}
    for kind in ("song", "quartet"):
        sub = [r for r in lines if r["kind"] == kind]
        summary[kind] = {"lines": len(sub), "meanOts": round(sum(r["ots"] for r in sub) / max(1, len(sub)), 4), "meanHomr": round(sum(r["homr"] for r in sub) / max(1, len(sub)), 4), "otsBetter": sum(1 for r in sub if r["gain"] > 0.02), "homrBetter": sum(1 for r in sub if r["gain"] < -0.02), "equal": sum(1 for r in sub if abs(r["gain"]) <= 0.02)}
    args.out.write_text(json.dumps({"summary": summary, "ranked": lines}, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
