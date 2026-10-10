"""Render the best-ranked pages of a pool as candidate examples and write the curation page.

Reads rank_pool.py's ranking, takes the pages where OTS-HOMR scores higher than HOMR by at least --min-gain (best first,
at most --limit), and renders each as rows of scan / HOMR / OTS-HOMR (build_overlay_gallery.build_case) under --out.
The curation page (index.html there) lists them in rank order with an Exclude checkbox on each and exports the choice.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from build_overlay_gallery import build_case
from markup_repair import repair_musicxml
from score_direction_placement import fetch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ranking", type=Path, required=True)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--homr-xml", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--mongo-uri", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--min-gain", type=float, default=0.03)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    ranking = json.loads(args.ranking.read_text())
    jobs = {Path(json.loads(l)["image"]).stem: {"jobId": json.loads(l)["jobId"], "token": token, "mongo": args.mongo_uri} for l in args.jobs.read_text().splitlines()}
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    chosen = [r for r in ranking["ranked"] if r["gain"] >= args.min_gain][: args.limit]
    cases = []
    for rank, row in enumerate(chosen, 1):
        page = row["page"]
        raw = fetch(f"{args.api}/{row['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", token)
        ots_xml = args.out / f"{page}.ots.musicxml"
        ots_xml.write_bytes(repair_musicxml(raw, drop_beams=True)[0])
        try:
            case = build_case(args.node, args.modules, page, page, args.homr_xml / f"{page}.musicxml", ots_xml, "engines", args.out, True, jobs[page])
        except SystemExit as error:
            print("skipped", page, error, flush=True)
            continue
        case.update(rank=rank, kind=row["kind"], ots=row["ots"], homr=row["homr"], gain=row["gain"])
        cases.append(case)
        print(rank, page, row["kind"], row["gain"], case["counts"], "scan crops" if case["hasScan"] else "no scan", flush=True)
    (args.out / "manifest.json").write_text(json.dumps({"summary": ranking["summary"], "cases": cases}))
    shutil.copy(Path(__file__).with_name("curation.html"), args.out / "index.html")
    print(len(cases), "candidates written to", args.out)


if __name__ == "__main__":
    main()
