"""Render the best-ranked individual lines of a pool as candidate examples and write the curation page.

Reads rank_lines.py's ranking, takes the lines where OTS-HOMR scores higher than HOMR by at least --min-gain (best first,
at most --limit) and renders each as one row of scan / HOMR / OTS-HOMR (build_overlay_gallery.build_case, one call per
page, only the chosen lines). The curation page (index.html in --out) lists the lines in rank order with an Include
checkbox on each and exports the choice.
"""

import argparse
import json
import os
import shutil
import sys
from collections import defaultdict
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
    parser.add_argument("--per-category", default="quartet=12,song=8", help="how many lines to take from each category, e.g. quartet=12,song=8")
    parser.add_argument("--min-gain", type=float, default=0.01)
    parser.add_argument("--extra", type=Path, help="a directory holding items.json (and its files) from pdmx_lines.py")
    parser.add_argument("--extra-limit", type=int, default=10)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    ranking = json.loads(args.ranking.read_text())
    jobs = {Path(json.loads(l)["image"]).stem: {"jobId": json.loads(l)["jobId"], "token": token, "mongo": args.mongo_uri} for l in args.jobs.read_text().splitlines()}
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    quotas = {k: int(v) for k, v in (pair.split("=") for pair in args.per_category.split(","))}
    chosen, taken = [], {}
    for r in ranking["ranked"]:
        if r["gain"] >= args.min_gain and taken.get(r["kind"], 0) < quotas.get(r["kind"], 0):
            chosen.append(r)
            taken[r["kind"]] = taken.get(r["kind"], 0) + 1
    by_page = defaultdict(list)
    for row in chosen:
        by_page[row["page"]].append(row)
    rendered = {}
    for page, rows in by_page.items():
        raw = fetch(f"{args.api}/{rows[0]['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", token)
        ots_xml = args.out / f"{page}.ots.musicxml"
        ots_xml.write_bytes(repair_musicxml(raw, drop_beams=True)[0])
        case = build_case(args.node, args.modules, page, page, args.homr_xml / f"{page}.musicxml", ots_xml, "engines", args.out, True, jobs[page], only={r["line"] for r in rows})
        for row in case["rows"]:
            rendered[(page, row["line"])] = row
        print(page, "rendered lines", sorted(r["line"] for r in rows), flush=True)
    items, ranks = [], {}
    for row in chosen:
        rendered_row = rendered.get((row["page"], row["line"]))
        if rendered_row is None:
            continue
        ranks[row["kind"]] = ranks.get(row["kind"], 0) + 1
        items.append({**{k: row[k] for k in ("id", "page", "line", "kind", "ots", "homr", "gain")}, "rank": ranks[row["kind"]], "row": rendered_row})
    summary = dict(ranking["summary"])
    if args.extra:
        extra = json.loads((args.extra / "items.json").read_text())
        summary["pdmx"] = extra["summary"]
        kept = [i for i in extra["items"] if sum(i["row"]["counts"].values()) > 0][: args.extra_limit]
        for rank, item in enumerate(kept, 1):
            item["rank"] = rank
            shutil.copytree(args.extra / item["id"], args.out / item["id"], dirs_exist_ok=True)
            items.append(item)
    (args.out / "manifest.json").write_text(json.dumps({"summary": summary, "items": items}))
    shutil.copy(Path(__file__).with_name("curation.html"), args.out / "index.html")
    print(len(items), "lines written to", args.out)


if __name__ == "__main__":
    main()
