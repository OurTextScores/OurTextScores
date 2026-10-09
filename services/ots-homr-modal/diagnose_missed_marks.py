"""Why were native dynamics/words not offered? Per missed native mark: what e4, OCR and the offered rows did there.

Needs: ground-truth-score.json (score_direction_placement), e4-rasters/<job>.{png,json,ocr.json}, note_positions.json
(note_positions.cjs) and the scanner's inventories. Categories, in the order a mark can fail:
  no-note        the aligned score has no note position at that onset (cannot even be located)
  offered-other  a row was offered nearby but with different text
  withheld       a row was found nearby and withheld (reason recorded)
  ocr-unselected OCR read something nearby that was not offered (text recorded)
  e4-only        e4 boxed it but OCR read nothing nearby (classifier label and probability recorded)
  nothing        neither e4 nor OCR saw anything nearby
"""

import argparse
import collections
import difflib
import json
import re
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--truth", type=Path, required=True)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--rasters", type=Path, required=True)
    parser.add_argument("--positions", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--mark", default="p")
    parser.add_argument("--kind", default="dynamic")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import torch
    from dynamics_reader import IMAGE_SIZE, MARGIN, DynamicsReader

    reader = DynamicsReader()
    details = json.loads(args.truth.read_text())["details"]
    positions = json.loads(args.positions.read_text())
    job_of = {Path(json.loads(l)["image"]).parent.name: json.loads(l)["jobId"] for l in args.jobs.read_text().splitlines()}
    norm = lambda t: re.sub(r"[^a-zà-ÿ]", "", t.lower())
    same = lambda a, b: norm(a) == norm(b) if args.kind == "dynamic" else (bool(norm(a)) and difflib.SequenceMatcher(None, norm(a), norm(b)).ratio() >= 0.8)
    results, cases = collections.Counter(), []
    for page in details:
        job = job_of[page["score"]]
        used, missed = set(), []
        for t in page["truth"]:
            hit = [i for i, r in enumerate(page["rows"]) if i not in used and r["kind"] == t["kind"] and same(r["text"], t["text"])]
            if hit:
                used.add(hit[0])
            elif t["kind"] == args.kind and norm(t["text"]) == norm(args.mark):
                missed.append(t)
        if not missed:
            continue
        inventory = json.loads(urllib.request.urlopen(urllib.request.Request(f"http://localhost:4000/api/scanner/jobs/{job}/pages/1/lyric-candidates", headers={"Authorization": f"Bearer {args.token}"}), timeout=120).read())["ocrRows"]
        raster = cv2.imread(str(args.rasters / f"{job}.png"), cv2.IMREAD_GRAYSCALE)
        ocr = json.loads((args.rasters / f"{job}.ocr.json").read_text())
        e4 = json.loads((args.rasters / f"{job}.json").read_text())["dynamicBoxes"]
        xml_notes = {}
        import xml.etree.ElementTree as ET
        from score_direction_placement import parse_parts

        page_parts = parse_parts(ET.fromstring((args.rasters.parent / "job-data" / f"{job}.musicxml").read_bytes()))
        for t in missed:
            part_id = f"P{t['part'] + 1}"
            onsets = page_parts[t["part"]][t["measure"] - 1]["onsets"] if t["part"] < len(page_parts) and t["measure"] - 1 < len(page_parts[t["part"]]) else []
            wanted = {json.dumps([part_id, t["measure"], i + 1], separators=(",", ":")) for i, o in enumerate(onsets) if abs(o - t["onset"]) <= 0.5}
            spots = [n for n in positions.get(job, []) if n["noteId"] in wanted]
            if not spots:
                results["no-note"] += 1
                cases.append({"score": page["score"], "category": "no-note", "measure": t["measure"]})
                continue
            spot = min(spots, key=lambda n: abs(n["x"] - np.mean([s["x"] for s in spots])))
            top, bottom = spot["region"][1], spot["region"][3]
            height = bottom - top
            inside = lambda b: spot["x"] - 110 <= (b[0] + b[2]) / 2 <= spot["x"] + 110 and top - 0.3 * height <= (b[1] + b[3]) / 2 <= bottom + 1.1 * height
            offered = [r for r in inventory if r.get("proposedDirection") and inside(r["box"])]
            withheld = [r for r in inventory if r.get("kind") in ("words", "dynamic") and not r.get("proposedDirection") and inside(r["box"])]
            ocr_near = [r for r in ocr if inside(r["box"])]
            boxes = [b for b in e4 if inside([b["left"], b["top"], b["right"], b["bottom"]]) and (b["right"] - b["left"]) * (b["bottom"] - b["top"]) >= 60]
            labels = []
            for b in boxes:
                crop = raster[max(0, b["top"] - MARGIN) : b["bottom"] + MARGIN, max(0, b["left"] - MARGIN) : b["right"] + MARGIN]
                if min(crop.shape) < 4:
                    continue
                x = torch.from_numpy(cv2.resize(crop, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0)[None, None]
                with torch.no_grad():
                    p = torch.softmax(reader.model(x), dim=-1)[0]
                labels.append((reader.labels[int(p.argmax())], round(float(p.max()), 2), (b["right"] - b["left"]) * (b["bottom"] - b["top"])))
            if offered:
                category = "offered-other"
            elif withheld:
                category = "withheld"
            elif ocr_near:
                category = "ocr-unselected"
            elif boxes:
                category = "e4-only"
            else:
                category = "nothing"
            results[category] += 1
            cases.append({"score": page["score"], "category": category, "measure": t["measure"], "x": round(spot["x"]), "region": spot["region"], "offered": [r["text"] for r in offered], "withheld": [(r["text"], r.get("withheldReason")) for r in withheld], "ocr": [(r["text"], r["semantic"]) for r in ocr_near][:6], "e4": labels[:6], "job": job})
    args.out.write_text(json.dumps({"counts": results, "cases": cases}, indent=1))
    print(dict(results))
    for category in ("offered-other", "withheld", "ocr-unselected", "e4-only", "nothing"):
        sample = [c for c in cases if c["category"] == category][:6]
        for c in sample:
            print(category, c["score"], "m", c["measure"], {k: c[k] for k in ("offered", "withheld", "ocr", "e4") if c.get(k)})


if __name__ == "__main__":
    main()
