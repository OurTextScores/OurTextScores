"""Source-free context pilot on frozen page inventories; does not change runtime."""

import argparse
import hashlib
import json
from pathlib import Path

from lyric_context_diagnostic import direction_context


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    import cv2
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    b = args.base
    source = Path(__file__).resolve().parent
    fusion_path = b / "frozen-fusion-cpu-20261008/pages.jsonl"
    pages = [json.loads(line) for line in fusion_path.read_text().splitlines()]
    pool = {
        p["id"]: p
        for p in map(
            json.loads,
            (b / "fusion-lyrics-test-20261008/pages.jsonl").read_text().splitlines(),
        )
    }
    inventories = b / "lyric-corrected-anchor-qualification-20261008/corrected"
    report_path = inventories / "report.json"
    report = json.loads(report_path.read_text())
    expected = {r["id"]: r["inventorySha256"] for r in report["pages"]}
    binding = {
        str(p): sha(p)
        for p in [
            Path(__file__),
            source / "lyric_context_diagnostic.py",
            source / "lyric_ocr.py",
            source / "semantic_gate.py",
            source / "models/semantic-lyrics-v1.json",
            fusion_path,
            report_path,
        ]
    }
    args.out.mkdir(parents=True, exist_ok=True)
    identity = args.out / "input-binding.json"
    if identity.exists() and json.loads(identity.read_text()) != binding:
        raise ValueError("Resume inputs or source changed")
    identity.write_text(json.dumps(binding, indent=2) + "\n")
    output = args.out / "pages.jsonl"
    done = (
        {r["id"]: r for r in map(json.loads, output.read_text().splitlines())}
        if output.exists()
        else {}
    )
    gate = SemanticGate.load()
    pipeline = LyricTextPipeline(gate, threads=2)
    with output.open("a") as file:
        for page in pages:
            if page["id"] in done:
                continue
            image = Path(pool[page["id"]]["image"])
            if sha(image) != page["image_sha256"]:
                raise ValueError("Image changed")
            inventory_path = (
                inventories / f"{page['score']}_{page['id'].split(':')[-1]}.json"
            )
            if sha(inventory_path) != expected[page["id"]]:
                raise ValueError("Inventory changed")
            inventory = json.loads(inventory_path.read_text())
            full = pipeline.read_page(cv2.imread(str(image)))
            changes = []
            for row in inventory["ocrRows"]:
                context = direction_context(row, full, gate)
                if context:
                    changes.append(
                        {
                            "id": row["id"],
                            "text": row["text"],
                            "box": row["box"],
                            **context,
                        }
                    )
            record = {
                "id": page["id"],
                "corpus": page["corpus"],
                "baselineRetained": sum(
                    r["proposedLyric"] for r in inventory["ocrRows"]
                ),
                "pilotRetained": sum(r["proposedLyric"] for r in inventory["ocrRows"])
                - len(changes),
                "changedRows": changes,
                "fullOcrRows": full,
                "imageSha256": sha(image),
                "inventorySha256": sha(inventory_path),
            }
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
            file.flush()
            done[page["id"]] = record
            print(
                f"{len(done)}/{len(pages)} {page['score']} changed {len(changes)}",
                flush=True,
            )
    totals = {}
    for row in done.values():
        counts = totals.setdefault(
            row["corpus"],
            {"pages": 0, "baselineRetained": 0, "pilotRetained": 0, "changedRows": 0},
        )
        counts["pages"] += 1
        for key in ["baselineRetained", "pilotRetained"]:
            counts[key] += row[key]
        counts["changedRows"] += len(row["changedRows"])
    result = {
        "scope": "Unshipped development pilot on previously inspected examples; no independent release accuracy claim, no attachment, no runtime or original verdict changes",
        "totals": totals,
        "rowsSha256": sha(output),
        "inputBindingSha256": sha(identity),
    }
    (args.out / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
