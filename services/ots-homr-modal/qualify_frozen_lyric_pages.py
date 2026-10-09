"""Hash-bound production OCR/semantic replay; never infer reference box links.

Uses fixed selected Lieder pages and OSSQ controls, cached detector predictions,
and the exact shipped LyricTextPipeline. Native references are scored only when
independent pixel/ownership links exist; this preflight does not manufacture them.
"""

import argparse
import hashlib
import json
import time
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inventory(paths):
    out = {}
    for path in paths:
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if row["id"] in out:
                raise ValueError("duplicate page ID")
            out[row["id"]] = row
    return out


def verify_page(page, detection):
    if (
        page["id"] != detection["id"]
        or page["image_sha256"] != detection["image_sha256"]
    ):
        raise ValueError("detector/page identity mismatch")
    if sha(page["image"]) != page["image_sha256"]:
        raise ValueError("frozen image checksum mismatch")
    return [box["box"] for box in detection["boxes"] if box["rawConfidence"] >= 0.5]


def main():
    import cv2
    from lyric_ocr import LyricTextPipeline
    from semantic_gate import SemanticGate

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    selected_path = (
        args.base / "lyric-native-reference-readiness-20261008-v3/candidate-pages.json"
    )
    native_path = (
        args.base
        / "lyric-native-reference-readiness-20261008-v3/native-page-lyrics.json"
    )
    pages_path = args.base / "fusion-lyrics-test-20261008/pages.jsonl"
    detector_paths = sorted(
        (args.base / "fusion-lyrics-test-20261008/detections").glob("*.jsonl")
    )
    detections = inventory(detector_paths)
    selected = json.loads(selected_path.read_text())
    controls = [p for p in inventory([pages_path]).values() if p["corpus"] == "ossq"]
    pages = selected + controls
    native = json.loads(native_path.read_text())
    code_root = Path(__file__).resolve().parent
    sources = [
        Path(__file__),
        code_root / "lyric_ocr.py",
        code_root / "semantic_gate.py",
        code_root / "models/semantic-lyrics-v1.json",
        code_root / "ots_engine.py",
        selected_path,
        native_path,
        pages_path,
        *detector_paths,
    ]
    binding = {str(p): sha(p) for p in sources}
    args.out.mkdir(parents=True, exist_ok=True)
    binding_path = args.out / "input-binding.json"
    if binding_path.exists() and json.loads(binding_path.read_text()) != binding:
        raise ValueError("resume source/input identity changed")
    binding_path.write_text(json.dumps(binding, indent=2) + "\n")
    for page in pages:
        verify_page(page, detections[page["id"]])
    results = args.out / "rows.jsonl"
    done = inventory([results]) if results.exists() else {}
    if set(done) - {p["id"] for p in pages}:
        raise ValueError("unexpected resumed page IDs")
    pipeline = LyricTextPipeline(SemanticGate.load(), threads=2)
    with results.open("a") as handle:
        for page in pages:
            if page["id"] in done:
                continue
            boxes = verify_page(page, detections[page["id"]])
            start = time.monotonic()
            result = pipeline.lyric_rows(cv2.imread(page["image"]), boxes)
            record = {
                "id": page["id"],
                "score": page["score"],
                "corpus": page["corpus"],
                "image_sha256": page["image_sha256"],
                "seconds": time.monotonic() - start,
                "rawE2BoxesAtPoint5": len(boxes),
                **result,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            done[page["id"]] = record
            print(
                f"{len(done)}/{len(pages)} {page['score']} {len(result['rows'])} rows {record['seconds']:.1f}s",
                flush=True,
            )
    summaries = {}
    for corpus in ["lieder", "ossq"]:
        group = [done[p["id"]] for p in pages if p["corpus"] == corpus]
        summaries[corpus] = {
            "pages": len(group),
            "rawE2BoxesAtPoint5": sum(p["rawE2BoxesAtPoint5"] for p in group),
            "ocrRows": sum(len(p["rows"]) for p in group),
            "semanticProposals": sum(
                r["proposedLyric"] for p in group for r in p["rows"]
            ),
            "rowsOmitted": sum(p["rowsOmitted"] for p in group),
            "seconds": sum(p["seconds"] for p in group),
        }
    report = {
        "schemaVersion": "ots.frozen-lyric-stage-qualification.v1",
        "status": "ocr-semantic-replay-complete; full-qualification-blocked",
        "selectedLiederNativeTargets": sum(len(native[p["id"]]) for p in selected),
        "stages": summaries,
        "bindingSha256": sha(binding_path),
        "rowsSha256": sha(results),
        "missingInputs": [
            "Exact independently certified detector/OCR-row to native syllable and note/verse links",
            "Three logical detector-route outputs for complete fusion-v1 replay",
            "Generated recognition and note-placement records for the fixed pages",
            "OSSQ scan/source no-lyrics correspondence certification",
        ],
        "limits": [
            "Source text and note labels are not inference inputs.",
            "Counts are stage coverage, not precision, transcription accuracy or recall.",
            "OSSQ proposals are pre-attachment suggestions, not attached false positives.",
            "Historical imperfect-box judgements and vocabulary proxy statistics are not used as gates.",
            "Cached e2 collection lacks an executed collector source/model identity receipt; pinned detector identity must still be established.",
            "Known training/index exposure means this set is not verified untouched.",
        ],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summaries), flush=True)


if __name__ == "__main__":
    main()
