"""Does shifting a mark's reference point right before counting bar lines place more rows in a native measure?

For each direction row on an aligned page, its measure is recomputed from the staff's bar lines with the row's
reference x (centre for a dynamic, left edge for words) shifted by `delta` px, mapped to the score's measure through the
aligned notes of that staff, and compared with the measures where the same text is natively printed. delta 0 is the
shipped rule; a positive delta moves marks that end just before a bar line into the next measure.
"""

import argparse
import collections
import difflib
import json
import re
import urllib.request
from pathlib import Path

DELTAS = [-20, 0, 10, 20, 30, 40, 60, 80, 120]
norm = lambda t: re.sub(r"[^a-zà-ÿ]", "", t.lower())


def same(kind, a, b):
    return norm(a) == norm(b) if kind == "dynamic" else bool(norm(a)) and bool(norm(b)) and difflib.SequenceMatcher(None, norm(a), norm(b)).ratio() >= 0.8


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", action="append", nargs=4, metavar=("NAME", "JOBS", "GT", "DIR"), required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = {}
    for name, jobs_file, gt_file, directory in args.set:
        directory = Path(directory)
        truth = {p["score"]: p["truth"] for p in json.loads(Path(gt_file).read_text())["details"]}
        positions = json.loads((directory / "note-positions.json").read_text())
        tally = collections.defaultdict(lambda: collections.Counter())
        for line in Path(jobs_file).read_text().splitlines():
            job = json.loads(line)
            score = Path(job["image"]).parent.name
            if score not in truth or job["jobId"] not in positions:
                continue
            staves = {s["index"]: s for s in json.loads((directory / "job-data" / f"{job['jobId']}.staves.json").read_text())}
            # (staff, measure index in the staff) -> score measure, from the aligned notes
            votes = collections.defaultdict(collections.Counter)
            for note in positions[job["jobId"]]:
                staff = staves.get(note["staff"])
                if staff:
                    votes[(note["staff"], sum(1 for b in staff["barLines"] if b < note["x"]))][json.loads(note["noteId"])[1]] += 1
            measure_of = {key: counter.most_common(1)[0][0] for key, counter in votes.items()}
            inventory = json.loads(urllib.request.urlopen(urllib.request.Request(f"{args.api}/{job['jobId']}/pages/1/lyric-candidates", headers={"Authorization": f"Bearer {args.token}"}), timeout=120).read())["ocrRows"]
            for row in inventory:
                if row.get("kind") not in ("words", "dynamic") or not row.get("anchor"):
                    continue
                kind, text = row["kind"], row.get("mark") or row["text"]
                natives = {t["measure"] for t in truth[score] if t["kind"] == kind and same(kind, text, t["text"])}
                if not natives:
                    continue
                staff = staves.get(row["anchor"]["staffIndex"])
                if not staff:
                    continue
                x = (row["box"][0] + row["box"][2]) / 2 if kind == "dynamic" else row["box"][0]
                same_staff = [n for n in positions[job["jobId"]] if n["staff"] == staff["index"]]
                variants = {}
                if same_staff:
                    nearest = min(same_staff, key=lambda n: abs(n["x"] - x))
                    variants["nearest-note"] = json.loads(nearest["noteId"])[1]
                    following = [n for n in same_staff if n["x"] >= row["box"][0] - 5]
                    variants["next-note"] = json.loads(min(following, key=lambda n: n["x"])["noteId"])[1] if following else None
                if variants:
                    shipped = measure_of.get((staff["index"], sum(1 for b in staff["barLines"] if b < x)))
                    own_note_in_measure = any(measure_of.get((staff["index"], sum(1 for b in staff["barLines"] if b < n["x"]))) == shipped and shipped is not None for n in same_staff)
                    pair = ("known" if shipped is not None else "unknown", "shipped-right" if shipped in natives else "shipped-wrong", "nearest-right" if variants["nearest-note"] in natives else "nearest-wrong")
                    tally[(kind, "pair:" + "/".join(pair))]["rows"] += 1
                for variant, measure in variants.items():
                    tally[(kind, variant)]["rows"] += 1
                    tally[(kind, variant)]["right"] += measure in natives
                for delta in DELTAS:
                    measure = measure_of.get((staff["index"], sum(1 for b in staff["barLines"] if b < x + delta)))
                    tally[(kind, delta)]["rows"] += 1
                    tally[(kind, delta)]["right"] += measure in natives
                    tally[(kind, delta)]["unknown"] += measure is None
        report[name] = {f"{kind}/{delta}": dict(c) for (kind, delta), c in sorted(tally.items(), key=lambda kv: (kv[0][0], str(kv[0][1])))}
    args.out.write_text(json.dumps(report, indent=1))
    for name, table in report.items():
        print(f"== {name}")
        pairs = collections.Counter()
        for key, value in table.items():
            if "/pair:" in key:
                pairs[key.split("/", 1)[0] + " " + key.split("pair:")[1]] += value["rows"]
        for key, value in sorted(pairs.items()):
            print("    ", key, value)
        for kind in ("dynamic", "words"):
            print(" ", kind.ljust(8), "  ".join(f"d{delta:+d}:{table[f'{kind}/{delta}']['right']}/{table[f'{kind}/{delta}']['rows']}" for delta in DELTAS if f"{kind}/{delta}" in table), "|", "  ".join(f"{v}:{table[f'{kind}/{v}']['right']}/{table[f'{kind}/{v}']['rows']}" for v in ("nearest-note", "next-note") if f"{kind}/{v}" in table))


if __name__ == "__main__":
    main()
