"""Build the public examples gallery from the owner's exported selection.

Each included line is rebuilt from the provider's output after the markup repair (what the product returns), rendered
next to HOMR's reading of the same line, and written to <public>/devs-assets/ots-homr-examples/manifest.json together
with the pool statistics, so the page can show how the picks relate to the whole set they were picked from.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from build_overlay_gallery import build_case, content_box, render
from diff_pages import compare
from markup_repair import repair_musicxml
from score_direction_placement import fetch

ORDER = ["quartet", "song", "pdmx"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--pool", type=Path, required=True, help="the pool directory (scanned.jsonl, upstream-out)")
    parser.add_argument("--pdmx", type=Path, required=True, help="pdmx_lines.py output directory")
    parser.add_argument("--ranking", type=Path, required=True, help="rank_lines.py output, for the pool statistics")
    parser.add_argument("--node", required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--mongo-uri", required=True)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    selection = json.loads(args.selection.read_text())["included"]
    out = args.public / "devs-assets" / "ots-homr-examples"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    jobs = {Path(json.loads(l)["image"]).stem: {"jobId": json.loads(l)["jobId"], "token": token, "mongo": args.mongo_uri} for l in (args.pool / "scanned.jsonl").read_text().splitlines()}
    items = []
    by_page = defaultdict(list)
    for chosen in selection:
        if chosen["category"] in ("quartet", "song"):
            by_page[chosen["page"]].append(chosen)
    rows = {}
    for page, lines in by_page.items():
        raw = fetch(f"{args.api}/{jobs[page]['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", token)
        ots_xml = out / f"{page}.ots.musicxml"
        ots_xml.write_bytes(repair_musicxml(raw, drop_beams=True)[0])
        case = build_case(args.node, args.modules, page, page, args.pool / "upstream-out" / f"{page}.musicxml", ots_xml, "engines", out, True, jobs[page], only={c["line"] for c in lines})
        for row in case["rows"]:
            rows[(page, row["line"])] = row
        ots_xml.unlink()
    pdmx = {i["id"]: i for i in json.loads((args.pdmx / "items.json").read_text())["items"]}
    for chosen in selection:
        if chosen["category"] == "pdmx":
            item = pdmx[chosen["id"]]
            cid = item["id"]
            case_dir = out / cid
            case_dir.mkdir()
            ots_fixed = case_dir / "ots.musicxml"
            ots_fixed.write_bytes(repair_musicxml((args.pdmx / "ots" / f"{cid}.musicxml").read_bytes(), drop_beams=True)[0])
            with tempfile.TemporaryDirectory() as tmp:
                lbase, rbase = Path(tmp) / "l", Path(tmp) / "r"
                lx = render(args.node, args.pdmx / "homr" / f"{cid}.musicxml", lbase, args.modules, True)
                rx = render(args.node, ots_fixed, rbase, args.modules, True)
                llay, rlay = (json.loads(Path(str(b) + ".layout.json").read_text()) for b in (lbase, rbase))
                result = compare(lx, rx, llay, rlay, "engines", beams=False)
                (case_dir / "left.svg").write_bytes(Path(str(lbase) + ".svg").read_bytes())
                (case_dir / "right.svg").write_bytes(Path(str(rbase) + ".svg").read_bytes())
            ots_fixed.unlink()
            shutil.copy(args.pdmx / cid / "crop.jpg", case_dir / "crop.jpg")
            rows[(cid, 1)] = {"line": 1, "scan": {"src": f"{cid}/crop.jpg"}, "counts": result["counts"],
                              "left": {"svg": f"{cid}/left.svg", "width": llay["width"], "height": llay["height"], "content": content_box(llay), **result["left"]},
                              "right": {"svg": f"{cid}/right.svg", "width": rlay["width"], "height": rlay["height"], "content": content_box(rlay), **result["right"]}}
    for kind in ORDER:
        for chosen in sorted((c for c in selection if c["category"] == kind), key=lambda c: c["rankInCategory"]):
            key = (chosen["id"], 1) if kind == "pdmx" else (chosen["page"], chosen["line"])
            if key not in rows:
                print("missing", chosen["id"])
                continue
            items.append({"id": chosen["id"], "page": chosen["page"], "line": chosen["line"], "kind": kind, "ots": chosen["ots"], "homr": chosen["homr"], "gain": chosen["gain"], "row": rows[key]})
    pool = json.loads(args.ranking.read_text())["summary"]
    pool["pdmx"] = json.loads((args.pdmx / "items.json").read_text())["summary"]
    pool["pagesScanned"] = len(jobs)
    (out / "manifest.json").write_text(json.dumps({"summary": pool, "items": items}))
    print(len(items), "lines published;", {k: sum(1 for i in items if i["kind"] == k) for k in ORDER})


if __name__ == "__main__":
    main()
