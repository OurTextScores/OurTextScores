"""Development-only e2 selection sweep using prepared pixels and exact backend filters."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    import cv2
    from lyric_ocr import MAX_ROWS, LyricTextPipeline, _rect, select_rows
    from semantic_gate import SemanticGate

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    b = args.base
    prepared = b / "lyric-prepared-controls-20261008"
    pages = json.loads((prepared / "pages.json").read_text())
    fusion = {
        r["id"]: r
        for r in map(
            json.loads, (prepared / "fusion/pages.jsonl").read_text().splitlines()
        )
    }
    backend = b / "lyric-corrected-anchor-qualification-20261008/corrected-backend"
    args.out.mkdir(parents=True, exist_ok=True)
    if (args.out / "report.json").exists():
        raise ValueError("Preserve completed sweep")
    gate = SemanticGate.load()
    pipeline = LyricTextPipeline(gate, threads=2)
    fixtures = []
    binding = {
        "runnerSha256": sha(Path(__file__)),
        "preparedPagesSha256": sha(prepared / "pages.json"),
        "fusionSha256": sha(prepared / "fusion/pages.jsonl"),
        "backendCompiledSha256": {
            p.name: sha(p) for p in (backend / "dist/scanner").glob("*.js")
        },
        "recognitionReviews": {},
    }
    all_ocr = []
    for page in pages:
        image = Path(page["image"])
        if sha(image) != page["image_sha256"]:
            raise ValueError("Prepared image changed")
        folder = (
            prepared / "recognition" / f"{page['score']}_{page['id'].split(':')[-1]}"
        )
        result = json.loads((folder / "result.json").read_text())
        review_path = folder / "review.json"
        if (
            result["status"] != "success"
            or sha(review_path) != result["outputSha256"]["review.json"]
        ):
            raise ValueError("Recognition missing or changed")
        binding["recognitionReviews"][page["id"]] = sha(review_path)
        staves = json.loads(review_path.read_text())["staves"]
        full = pipeline.read_page(cv2.imread(str(image)))
        all_ocr.append({"id": page["id"], "rows": full})
        for threshold in [0.5, 0.49, 0.45, 0.4, 0.35]:
            boxes = [
                [d["left"], d["top"], d["right"], d["bottom"]]
                for d in fusion[page["id"]]["rawDetections"]["lyrics"]
                if d["label"] == "Lyrics" and d["confidence"] >= threshold
            ]
            selected = sorted(
                select_rows(full, boxes),
                key=lambda r: (_rect(r["box"])[1], _rect(r["box"])[0]),
            )
            rows = []
            for row in selected[:MAX_ROWS]:
                verdict = gate.classify(row["text"])
                rows.append(
                    {
                        "box": [int(v) for v in _rect(row["box"])],
                        "text": row["text"],
                        "ocrConfidence": row["confidence"],
                        "regionCoverage": row["regionCoverage"],
                        "semantic": verdict["prediction"],
                        "semanticScore": verdict["score"],
                        "proposedLyric": verdict["proposedLyric"],
                    }
                )
            fixtures.append(
                {
                    "id": page["id"],
                    "score": page["score"],
                    "corpus": page["corpus"],
                    "threshold": threshold,
                    "detectorBoxes": len(boxes),
                    "fusedRegions": fusion[page["id"]]["fusion"]["regions"],
                    "raster": {
                        "checksumSha256": page["image_sha256"],
                        **fusion[page["id"]]["raster"],
                    },
                    "staves": staves,
                    "rows": rows,
                    "rowsOmitted": max(0, len(selected) - MAX_ROWS),
                }
            )
        print(page["score"], len(full), "full OCR rows", flush=True)
    (args.out / "full-ocr.json").write_text(
        json.dumps(all_ocr, ensure_ascii=False) + "\n"
    )
    inputs = args.out / "fixtures.json"
    inputs.write_text(json.dumps(fixtures, ensure_ascii=False) + "\n")
    binding["fixturesSha256"] = sha(inputs)
    binding["fullOcrSha256"] = sha(args.out / "full-ocr.json")
    (args.out / "input-binding.json").write_text(json.dumps(binding, indent=2) + "\n")
    script = """
const fs=require('fs');
const [backend,input,out]=process.argv.slice(1);
const {buildLyricCandidateInventory}=require(backend+'/dist/scanner/scanner-lyric-candidates');
const records=JSON.parse(fs.readFileSync(input)).map(p=>{
 const inventory=buildLyricCandidateInventory({fusedRegions:p.fusedRegions,lyricText:{status:'ok',rows:p.rows}},1,p.raster,p.staves);
 return {id:p.id,score:p.score,corpus:p.corpus,threshold:p.threshold,detectorBoxes:p.detectorBoxes,rowsOmitted:p.rowsOmitted,inventory};
});
fs.writeFileSync(out,JSON.stringify(records,null,2)+'\\n');
"""
    subprocess.run(
        [
            "node",
            "-e",
            script,
            str(backend),
            str(inputs),
            str(args.out / "inventories.json"),
        ],
        check=True,
    )
    records = json.loads((args.out / "inventories.json").read_text())
    totals = {}
    for record in records:
        counts = totals.setdefault(str(record["threshold"]), {}).setdefault(
            record["corpus"],
            {
                "selectedOcrRows": 0,
                "semanticProposals": 0,
                "retained": 0,
                "kissedRetained": False,
                "negativeSuggestions": [],
            },
        )
        rows = record["inventory"]["ocrRows"]
        counts["selectedOcrRows"] += len(rows)
        counts["semanticProposals"] += sum(
            r["proposedLyric"]
            for r in next(
                p
                for p in fixtures
                if p["id"] == record["id"] and p["threshold"] == record["threshold"]
            )["rows"]
        )
        counts["retained"] += sum(r["proposedLyric"] for r in rows)
        counts["kissedRetained"] |= any(
            "kiss" in r["text"].lower() and r["proposedLyric"] for r in rows
        )
        if record["corpus"] == "ossq":
            counts["negativeSuggestions"] += [
                {"page": record["id"], "text": r["text"]}
                for r in rows
                if r["proposedLyric"]
            ]
    report = {
        "scope": "Unshipped development threshold sweep on five inspected prepared controls. Counts are not genuine-lyric recall, OCR correctness or attachment accuracy. No runtime threshold changed.",
        "totals": totals,
        "inventoriesSha256": sha(args.out / "inventories.json"),
        "inputBindingSha256": sha(args.out / "input-binding.json"),
    }
    (args.out / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    )
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
