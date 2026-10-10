"""Build the overlay galleries: both readings rendered to SVG with the differences boxed on the page.

  engines  HOMR vs OTS-HOMR for the cases of devs-assets/ots-homr-pages (both normalised through MuseScore first)
  review   a scan result vs the same page with every suggestion accepted (devs-assets/ots-homr-lyrics)

Run with the emsdk node 22 (webmscore needs the navigator/fetch workaround in nonav.cjs), e.g.
  python3 build_overlay_gallery.py --node /path/to/node --public ../../../frontend/public --homr-normalised DIR
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from diff_pages import compare

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


def systems(layout):
    rows = {}
    for rect in layout["measures"]:
        rows.setdefault(round(rect["y"]), []).append(rect)
    return [{"x0": min(r["x"] for r in rs), "x1": max(r["x"] + r["sx"] for r in rs), "y": min(r["y"] for r in rs), "h": max(r["sy"] for r in rs)} for _, rs in sorted(rows.items())]


def build_case(node, modules, name, left_xml, right_xml, mode, out_dir, normalise):
    case_dir = out_dir / name
    case_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        left_base, right_base = Path(tmp) / "left", Path(tmp) / "right"
        lx = render(node, left_xml, left_base, modules, normalise)
        rx = render(node, right_xml, right_base, modules, normalise)
        left_layout = json.loads(Path(str(left_base) + ".layout.json").read_text())
        right_layout = json.loads(Path(str(right_base) + ".layout.json").read_text())
        result = compare(lx, rx, left_layout, right_layout, mode)
        shutil.copy(str(left_base) + ".svg", case_dir / "left.svg")
        shutil.copy(str(right_base) + ".svg", case_dir / "right.svg")
    return {
        "id": name,
        "counts": result["counts"],
        "countsLeft": result["countsLeft"],
        "measures": result["measures"],
        "left": {"svg": f"{name}/left.svg", "width": left_layout["width"], "height": left_layout["height"], "systems": systems(left_layout), **result["left"]},
        "right": {"svg": f"{name}/right.svg", "width": right_layout["width"], "height": right_layout["height"], "systems": systems(right_layout), **result["right"]},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--modules", type=Path, required=True, help="a node_modules directory containing webmscore")
    parser.add_argument("--homr-normalised", type=Path, required=True, help="HOMR page MusicXML files, one per case id (before normalising)")
    args = parser.parse_args()
    out = args.public / "devs-assets" / "ots-homr-overlay"
    out.mkdir(parents=True, exist_ok=True)
    engines = json.loads((args.public / "devs-assets/ots-homr-pages/manifest.json").read_text())
    cases = []
    for case in engines["cases"]:
        if not case["left"]:
            continue
        built = build_case(args.node, args.modules, case["id"], args.homr_normalised / f"{case['id']}.musicxml", args.public / "devs-assets/ots-homr-pages" / case["right"], "engines", out, True)
        built.update(title=case["id"], oursScore=case["ours"], homrScore=case["upstream"])
        cases.append(built)
        print("engines", case["id"], built["counts"], flush=True)
    review = json.loads((args.public / "devs-assets/ots-homr-lyrics/manifest.json").read_text())
    review_cases = []
    for case in review["cases"]:
        base = args.public / "devs-assets/ots-homr-lyrics"
        built = build_case(args.node, args.modules, "review-" + case["id"], base / case["left"], base / case["right"], "review", out, False)
        built.update(title=case["id"], **{k: case[k] for k in ("lyricsAdded", "wordsAdded", "dynamicsAdded")})
        review_cases.append(built)
        print("review", case["id"], built["counts"], flush=True)
    (out / "manifest.json").write_text(json.dumps({"engines": {"summary": engines["summary"], "cases": cases}, "review": {"summary": review["summary"], "cases": review_cases}}))


if __name__ == "__main__":
    main()
