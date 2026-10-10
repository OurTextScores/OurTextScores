"""Score every page of a pool with both engines against the encoded score, and rank the pages by how much better
OTS-HOMR reads them (pitch, duration and rests per measure, averaged over the page's parts; engine_vs_native.mean_part_score).

Lieder natives come from the OpenScore catalogue (score_direction_placement.native_candidates); quartet natives are the
`sq<id>.musicxml` files in --ossq-native. Pages whose reading cannot be aligned to the encoded score are listed apart.
"""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from engine_vs_native import mean_part_score as page_score
from markup_repair import repair_musicxml
from score_direction_placement import SOURCES, fetch, native_candidates


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
    ossq_cache = {}
    rows = []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        page = Path(job["image"]).stem
        score = page.split("-")[0]
        if score.startswith("sq"):
            if score not in ossq_cache:
                ossq_cache[score] = [(score, ET.parse(args.ossq_native / f"{score}.musicxml").getroot())]
            natives = ossq_cache[score]
            kind = "quartet"
        else:
            natives = list(native_candidates(score, catalogue))
            kind = "song"
        homr_file = args.homr_xml / f"{page}.musicxml"
        ours_xml = ET.fromstring(repair_musicxml(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token), drop_beams=True)[0])
        ours, ours_parts = page_score(ours_xml, natives) if natives else (None, [])
        homr, homr_parts = (page_score(ET.parse(homr_file).getroot(), natives) if homr_file.exists() and natives else (None, []))
        rows.append({"page": page, "kind": kind, "jobId": job["jobId"], "ots": None if ours is None else round(ours, 4), "homr": None if homr is None else round(homr, 4), "otsMeasures": ours_parts, "homrMeasures": homr_parts})
        print(page, kind, rows[-1]["ots"], rows[-1]["homr"], flush=True)
    scored = [r for r in rows if r["ots"] is not None and r["homr"] is not None and min(r["ots"], r["homr"]) > 0.3]
    for r in scored:
        r["gain"] = round(r["ots"] - r["homr"], 4)
    scored.sort(key=lambda r: -r["gain"])
    summary = {
        "pagesScanned": len(rows),
        "pagesScored": len(scored),
        "byKind": {k: {"pages": sum(1 for r in scored if r["kind"] == k), "meanOts": round(sum(r["ots"] for r in scored if r["kind"] == k) / max(1, sum(1 for r in scored if r["kind"] == k)), 4), "meanHomr": round(sum(r["homr"] for r in scored if r["kind"] == k) / max(1, sum(1 for r in scored if r["kind"] == k)), 4), "otsBetter": sum(1 for r in scored if r["kind"] == k and r["gain"] > 0.02), "homrBetter": sum(1 for r in scored if r["kind"] == k and r["gain"] < -0.02)} for k in ("song", "quartet")},
    }
    args.out.write_text(json.dumps({"summary": summary, "ranked": scored, "unscored": [r for r in rows if r not in scored]}, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
