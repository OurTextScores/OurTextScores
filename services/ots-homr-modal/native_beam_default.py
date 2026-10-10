"""How far the native OpenScore beaming departs from MuseScore's own default, and the lines to check against the scan.

Step 1: for every native score behind a held-out page, strip all beams, let MuseScore re-beam it by default, and compare
with the native beaming note by note (beamable notes only, first level). The notes that differ are the native
"overrides": where the encoded score says something MuseScore's default would not.
Step 2 (--review DIR): for each scan line (system) of each page, cut the aligned native measures out twice, once as
encoded and once with MuseScore's default beaming, render both, and keep the lines where they differ so the scan
can be judged against them.
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "overlay"))

import yaml

from beam_fair import BEAMABLE, note_states
from build_overlay_gallery import content_box, render
from diff_pages import compare
from engine_vs_native import parse_rhythm_parts
from lines import fetch_raster, scan_systems, system_count, system_ranges, write_range_excerpt
from score_direction_placement import SOURCES, align, fetch, native_candidates

HERE = Path(__file__).resolve().parent / "overlay"


def default_beaming(node, modules, root, directory, name):
    stripped = ET.fromstring(ET.tostring(root))
    for note in stripped.iter("note"):
        for beam in note.findall("beam"):
            note.remove(beam)
    source, out = directory / f"{name}.in.xml", directory / f"{name}.out.xml"
    ET.ElementTree(stripped).write(source, encoding="utf-8", xml_declaration=True)
    if out.exists():
        out.unlink()
    env = dict(os.environ, NODE_PATH=str(modules))
    subprocess.run([node, "-r", str(HERE / "nonav.cjs"), str(HERE / "normalize.cjs"), str(source), str(out)], check=True, env=env, timeout=300, capture_output=True)
    return ET.parse(out).getroot()


def best_alignment(page_root, natives):
    page_parts = parse_rhythm_parts(page_root)
    best = None
    for native_root in natives:
        native_parts = parse_rhythm_parts(native_root)
        for i, part in enumerate(page_parts):
            for j, native in enumerate(native_parts):
                start, score = align(part, native)
                if score >= 0.7 and (best is None or score > best[0]):
                    best = (score, native_root, i, j, start, len(part))
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--mongo-uri", required=True)
    parser.add_argument("--exclude", default="")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    skip = set(filter(None, args.exclude.split(",")))
    pages, items = [], []
    total = overrides = 0
    if args.review:
        args.review.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        for line in args.jobs.read_text().splitlines():
            job = json.loads(line)
            page, score = Path(job["image"]).stem, Path(job["image"]).parent.name
            if page in skip:
                continue
            natives = [root for _, root in native_candidates(score, catalogue)]
            page_root = ET.fromstring(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token))
            best = best_alignment(page_root, natives)
            if best is None:
                continue
            _, native_root, page_part, native_part, start, length = best
            default_root = default_beaming(args.node, args.modules, native_root, directory, "default")
            native_states, default_states = note_states(native_root)[native_part], note_states(default_root)[native_part]
            t = d = 0
            for k in range(start, min(start + length, len(native_states))):
                if len(native_states[k]) != len(default_states[k]):
                    continue
                for (a, kind), (b, _) in zip(native_states[k], default_states[k]):
                    if kind in BEAMABLE:
                        t += 1
                        d += a != b
            total += t
            overrides += d
            pages.append({"page": page, "beamableNotes": t, "overrides": d})
            print(page, t, d, flush=True)
            if not args.review:
                continue
            page_part_el = page_root.findall("part")[page_part]
            ranges = system_ranges(page_part_el)
            regions = scan_systems(job["jobId"], args.mongo_uri)
            raster = None
            if len(regions) == len(ranges):
                import cv2
                import numpy as np

                raster = cv2.imdecode(np.frombuffer(fetch_raster(job["jobId"], args.token), np.uint8), cv2.IMREAD_COLOR)
            for index, (a, b) in enumerate(ranges):
                base = args.review / f"{page}-L{index + 1}"
                write_range_excerpt(native_root, start + a, start + b, Path(str(base) + ".native.xml"))
                write_range_excerpt(default_root, start + a, start + b, Path(str(base) + ".default.xml"))
                lbase, rbase = Path(tmp) / "l", Path(tmp) / "r"
                lx = render(args.node, Path(str(base) + ".default.xml"), lbase, args.modules, False)
                rx = render(args.node, Path(str(base) + ".native.xml"), rbase, args.modules, False)
                llay = json.loads(Path(str(lbase) + ".layout.json").read_text())
                rlay = json.loads(Path(str(rbase) + ".layout.json").read_text())
                result = compare(lx, rx, llay, rlay, "engines")
                diffs = result["counts"].get("beam", 0)
                if not diffs:
                    continue
                scan_file = None
                if raster is not None:
                    region = regions[index]
                    crop = raster[max(0, region["y0"] - 45) : region["y1"] + 45, max(0, region["x0"] - 45) : region["x1"] + 45]
                    scan_file = f"{page}-L{index + 1}-scan.jpg"
                    cv2.imwrite(str(args.review / scan_file), crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
                for name, lay in (("default", llay), ("native", rlay)):
                    pass
                Path(str(base) + ".default.svg").write_bytes(Path(str(lbase) + ".svg").read_bytes())
                Path(str(base) + ".native.svg").write_bytes(Path(str(rbase) + ".svg").read_bytes())
                items.append({"id": f"{page}-L{index + 1}", "page": page, "beamDifferences": diffs, "scan": scan_file,
                              "left": {"svg": f"{page}-L{index + 1}.default.svg", "width": llay["width"], "height": llay["height"], "content": content_box(llay), **result["left"]},
                              "right": {"svg": f"{page}-L{index + 1}.native.svg", "width": rlay["width"], "height": rlay["height"], "content": content_box(rlay), **result["right"]}})
                print("  review line", index + 1, "beam differences", diffs, flush=True)
    summary = {"pages": len(pages), "beamableNotes": total, "overrides": overrides, "overrideShare": round(overrides / total, 4) if total else None,
               "medianPerPage": round(statistics.median(p["overrides"] / p["beamableNotes"] for p in pages if p["beamableNotes"]), 4) if pages else None}
    args.out.write_text(json.dumps({"summary": summary, "pages": pages}, indent=1))
    if args.review:
        (args.review / "items.json").write_text(json.dumps(items))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
