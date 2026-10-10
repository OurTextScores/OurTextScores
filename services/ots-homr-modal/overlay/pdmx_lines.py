"""PDMX lines (validation staff windows) where OTS-HOMR reads much better than HOMR, from the frozen benchmark's saved
predictions, rendered like any other candidate line.

For every PDMX validation window the benchmark saved both engines' six-branch predictions. This ranks the windows by
the edit-error difference (time-signature numerators dropped from both, as in the benchmark), takes the top ones, turns
each engine's symbols into MusicXML with that engine's own generator, renders both, and writes an items.json in the
format build_curation.py's page reads. Nothing is inferred here; the crops are the benchmark's rendered images, not scans.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from rapidfuzz.distance import Levenshtein

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_overlay_gallery import content_box, render
from diff_pages import compare

BRANCHES = ("rhythm", "pitch", "lift", "articulation", "slur", "position")


def load(directory, model):
    result = {}
    for file in sorted(Path(directory).glob(f"{model}-shard*.jsonl")):
        for line in file.read_text().splitlines():
            row = json.loads(line)
            if row["source"] == "pdmx" and row["status"] == "ok":
                result[os.path.basename(row["tokens"])] = row
    return result


def symbols(row, kind):
    columns = [row[f"{b}_{kind}"] for b in BRANCHES]
    rows = [list(symbol) for symbol in zip(*columns)]
    return [r for r in rows if not r[0].startswith("timeSignatureBeats_")]


def error_rate(row):
    reference, predicted = [tuple(s) for s in symbols(row, "reference")], [tuple(s) for s in symbols(row, "predicted")]
    return Levenshtein.distance(reference, predicted) / max(1, len(reference)), len(reference)


def run_generator(interpreter, pythonpath, items_file, out_dir):
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    if pythonpath:
        env["PYTHONPATH"] = str(pythonpath)
    done = subprocess.run([interpreter, str(Path(__file__).with_name("gen_rows.py")), str(items_file), str(out_dir)], capture_output=True, text=True, env=env, cwd="/tmp", timeout=900)
    if done.returncode:
        raise SystemExit(done.stderr[-600:])
    return json.loads(done.stdout.strip().splitlines()[-1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--shard", type=Path, required=True)
    parser.add_argument("--ots-source", type=Path, required=True, help="the extracted OTS homr source (contains homr/)")
    parser.add_argument("--upstream-python", required=True, help="python of a venv with the upstream homr installed")
    parser.add_argument("--generator-python", required=True, help="python that can import the OTS source (needs numpy, no torch)")
    parser.add_argument("--node", required=True)
    parser.add_argument("--modules", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=14)
    args = parser.parse_args()
    ots, up = load(args.predictions, "pinned20260918"), load(args.predictions, "upstream426")
    rows = []
    for key, o in ots.items():
        u = up.get(key)
        if u is None:
            continue
        oe, length = error_rate(o)
        ue, _ = error_rate(u)
        rows.append({"key": key, "score": key.split("-v")[0], "length": length, "ots": round(1 - oe, 4), "homr": round(1 - ue, 4), "gain": round(ue - oe, 4)})
    summary = {"lines": len(rows), "meanOts": round(sum(r["ots"] for r in rows) / len(rows), 4), "meanHomr": round(sum(r["homr"] for r in rows) / len(rows), 4), "otsBetter": sum(1 for r in rows if r["gain"] > 0.02), "homrBetter": sum(1 for r in rows if r["gain"] < -0.02), "equal": sum(1 for r in rows if abs(r["gain"]) <= 0.02)}
    print("all PDMX validation windows:", json.dumps(summary), flush=True)
    seen, chosen = set(), []
    for r in sorted(rows, key=lambda r: -r["gain"]):
        if r["length"] < 40 or r["ots"] < 0.88 or r["score"] in seen:
            continue
        seen.add(r["score"])
        chosen.append(r)
        if len(chosen) >= args.limit:
            break
    args.out.mkdir(parents=True, exist_ok=True)
    members = [f"datasets/pdmx/out/{c['key'][0:1]}" for c in chosen]  # replaced below by exact paths
    wanted = []
    listing = subprocess.run(["tar", "-I", "zstd", "-tf", str(args.shard)], capture_output=True, text=True, check=True).stdout.splitlines()
    by_name = {Path(m).name: m for m in listing if m.endswith(".jpg")}
    for c in chosen:
        wanted.append(by_name[c["key"].replace(".tokens", ".jpg")])
    subprocess.run(["tar", "-I", "zstd", "-xf", str(args.shard), "-C", str(args.out), *wanted], check=True)
    ids = {c["key"]: f"pdmx-{c['key'].replace('.tokens', '')}" for c in chosen}
    for kind, data, python, path in (("ots", ots, args.generator_python, args.ots_source), ("homr", up, args.upstream_python, None)):
        batch = [{"id": ids[c["key"]], "rows": symbols(data[c["key"]], "predicted")} for c in chosen]
        file = args.out / f"{kind}-rows.json"
        file.write_text(json.dumps(batch))
        print(kind, run_generator(python, path, file, args.out / kind), flush=True)
    items = []
    for rank, c in enumerate(chosen, 1):
        cid = ids[c["key"]]
        case_dir = args.out / cid
        case_dir.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            lbase, rbase = Path(tmp) / "l", Path(tmp) / "r"
            lx = render(args.node, args.out / "homr" / f"{cid}.musicxml", lbase, args.modules, True)
            rx = render(args.node, args.out / "ots" / f"{cid}.musicxml", rbase, args.modules, True)
            llay, rlay = (json.loads(Path(str(b) + ".layout.json").read_text()) for b in (lbase, rbase))
            result = compare(lx, rx, llay, rlay, "engines", beams=False)
            (case_dir / "left.svg").write_bytes(Path(str(lbase) + ".svg").read_bytes())
            (case_dir / "right.svg").write_bytes(Path(str(rbase) + ".svg").read_bytes())
        crop = next(args.out.glob(f"datasets/pdmx/out/*/*/{c['key'].replace('.tokens', '.jpg')}"))
        (case_dir / "crop.jpg").write_bytes(crop.read_bytes())
        row = {"line": 1, "scan": {"src": f"{cid}/crop.jpg", "width": 0, "height": 0}, "counts": result["counts"],
               "left": {"svg": f"{cid}/left.svg", "width": llay["width"], "height": llay["height"], "content": content_box(llay), **result["left"]},
               "right": {"svg": f"{cid}/right.svg", "width": rlay["width"], "height": rlay["height"], "content": content_box(rlay), **result["right"]}}
        items.append({"id": cid, "page": c["score"], "line": 1, "kind": "pdmx", "ots": c["ots"], "homr": c["homr"], "gain": c["gain"], "rank": rank, "row": row})
        print(rank, cid, c["gain"], result["counts"], flush=True)
    (args.out / "items.json").write_text(json.dumps({"summary": summary, "items": items}))


if __name__ == "__main__":
    main()
