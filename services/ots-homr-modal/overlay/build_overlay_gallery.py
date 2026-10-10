"""Build the overlay galleries, one row per line (system) of the scan.

  engines  HOMR vs OTS-HOMR for the cases of devs-assets/ots-homr-pages (both normalised through MuseScore first)
  review   a scan result vs the same page with every suggestion accepted (devs-assets/ots-homr-lyrics)

Each row holds the scan of that line, the two readings of that line rendered as small scores of their own (cut at the
scan's own system breaks), the boxes on the notes that differ, and the excerpt files the editor link opens.

Run with the emsdk node 22 (webmscore needs the navigator/fetch workaround in nonav.cjs), e.g.
  OTS_TOKEN=... python3 build_overlay_gallery.py --node /path/to/node --public ../../../frontend/public \\
      --modules ../../../frontend/node_modules --homr-xml DIR --jobs scanned-all.jsonl --mongo-uri URI
"""

import argparse
import io
import json
import os
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from diff_pages import compare
from lines import fetch_raster, scan_systems, write_excerpts

HERE = Path(__file__).resolve().parent


def run_node(node, script, *args, modules):
    env = dict(os.environ, NODE_PATH=str(modules))
    subprocess.run([node, "-r", str(HERE / "nonav.cjs"), str(HERE / script), *map(str, args)], check=True, env=env, timeout=300)


def render(node, xml, out, modules, normalise):
    if normalise:
        normalised = Path(str(out) + ".norm.xml")
        run_node(node, "normalize.cjs", xml, normalised, modules=modules)
        xml = normalised
    run_node(node, "render_layout.cjs", xml, out, modules=modules)
    return Path(xml)


def content_box(layout):
    rects = layout["measures"]
    x0, x1 = min(r["x"] for r in rects), max(r["x"] + r["sx"] for r in rects)
    y0, y1 = min(r["y"] for r in rects), max(r["y"] + r["sy"] for r in rects)
    return {"x": x0 - 90, "y": y0 - 150, "w": x1 - x0 + 180, "h": y1 - y0 + 330}


def side(layout, placed, svg):
    return {"svg": svg, "width": layout["width"], "height": layout["height"], "content": content_box(layout), **placed}


def build_case(node, modules, case_id, title, left_xml, right_xml, mode, out_dir, normalise, job, only=None):
    case_dir = out_dir / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    left_cuts = write_excerpts(left_xml, case_dir, "left")
    right_cuts = write_excerpts(right_xml, case_dir, "right")
    if len(left_cuts) != len(right_cuts):
        raise SystemExit(f"{case_id}: the two readings break into {len(left_cuts)} and {len(right_cuts)} lines")
    scans = None
    if job:
        regions = scan_systems(job["jobId"], job["mongo"])
        if len(regions) == len(left_cuts):
            raster = cv2.imdecode(np.frombuffer(fetch_raster(job["jobId"], job["token"]), np.uint8), cv2.IMREAD_COLOR)
            scans = []
            for index, region in enumerate(regions, 1):
                pad = 45
                crop = raster[max(0, region["y0"] - pad) : region["y1"] + pad, max(0, region["x0"] - pad) : region["x1"] + pad]
                name = f"scan-L{index}.jpg"
                cv2.imwrite(str(case_dir / name), crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
                scans.append({"src": f"{case_id}/{name}", "width": int(crop.shape[1]), "height": int(crop.shape[0])})
    rows, totals, totals_left = [], {}, {}
    for index, (lcut, rcut) in enumerate(zip(left_cuts, right_cuts), 1):
        if only is not None and index not in only:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            lbase, rbase = Path(tmp) / "left", Path(tmp) / "right"
            lx = render(node, lcut, lbase, modules, normalise)
            rx = render(node, rcut, rbase, modules, normalise)
            llay = json.loads(Path(str(lbase) + ".layout.json").read_text())
            rlay = json.loads(Path(str(rbase) + ".layout.json").read_text())
            result = compare(lx, rx, llay, rlay, mode, beams=False)  # neither reading writes beams; the editor beams both
            (case_dir / f"L{index}-left.svg").write_bytes(Path(str(lbase) + ".svg").read_bytes())
            (case_dir / f"L{index}-right.svg").write_bytes(Path(str(rbase) + ".svg").read_bytes())
        for kind, n in result["counts"].items():
            totals[kind] = totals.get(kind, 0) + n
        rows.append(
            {
                "line": index,
                "scan": scans[index - 1] if scans else None,
                "left": side(llay, result["left"], f"{case_id}/L{index}-left.svg"),
                "right": side(rlay, result["right"], f"{case_id}/L{index}-right.svg"),
                "counts": result["counts"],
                "editor": {"left": f"{case_id}/{lcut.name}", "right": f"{case_id}/{rcut.name}"},
            }
        )
    return {"id": case_id, "title": title, "counts": totals, "rows": rows, "hasScan": scans is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--modules", type=Path, required=True, help="a node_modules directory containing webmscore")
    parser.add_argument("--homr-xml", type=Path, required=True, help="HOMR page MusicXML files, one per case id")
    parser.add_argument("--jobs", type=Path, required=True, help="scanned.jsonl: {image, jobId} per line")
    parser.add_argument("--mongo-uri", required=True)
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    jobs = {}
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        jobs[Path(job["image"]).stem] = {"jobId": job["jobId"], "token": token, "mongo": args.mongo_uri}
    out = args.public / "devs-assets" / "ots-homr-overlay"
    if out.exists():
        import shutil

        shutil.rmtree(out)
    out.mkdir(parents=True)
    engines = json.loads((args.public / "devs-assets/ots-homr-pages/manifest.json").read_text())
    cases = []
    for case in engines["cases"]:
        if not case["left"]:
            continue
        built = build_case(args.node, args.modules, case["id"], case["id"], args.homr_xml / f"{case['id']}.musicxml", args.public / "devs-assets/ots-homr-pages" / case["right"], "engines", out, True, jobs.get(case["id"]))
        built.update(oursScore=case["ours"], homrScore=case["upstream"])
        cases.append(built)
        print("engines", case["id"], built["counts"], "scan crops" if built["hasScan"] else "NO SCAN CROPS", len(built["rows"]), "rows", flush=True)
    review = json.loads((args.public / "devs-assets/ots-homr-lyrics/manifest.json").read_text())
    review_cases = []
    base = args.public / "devs-assets/ots-homr-lyrics"
    for case in review["cases"]:
        built = build_case(args.node, args.modules, "review-" + case["id"], case["id"], base / case["left"], base / case["right"], "review", out, False, jobs.get(case["id"]))
        built.update(**{k: case[k] for k in ("lyricsAdded", "wordsAdded", "dynamicsAdded")})
        review_cases.append(built)
        print("review", case["id"], built["counts"], "scan crops" if built["hasScan"] else "NO SCAN CROPS", len(built["rows"]), "rows", flush=True)
    (out / "manifest.json").write_text(json.dumps({"engines": {"summary": engines["summary"], "cases": cases}, "review": {"summary": review["summary"], "cases": review_cases}}))


if __name__ == "__main__":
    main()
