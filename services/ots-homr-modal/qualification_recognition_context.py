"""Resume hash-bound local CPU recognition without supplying reference labels."""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    for relative, expected in manifest["runtimeSourceSha256"].items():
        assert sha(Path(manifest["runtimeRoot"]) / relative) == expected, relative
    for graph in manifest["graphs"].values():
        assert sha(graph["candidatePath"]) == graph["sha256"]
    assert sha(manifest["segmentation"]["path"]) == manifest["segmentation"]["sha256"]
    args.out.mkdir(parents=True, exist_ok=True)
    pages = json.loads(args.pages.read_text())
    identity = {
        "manifestSha256": sha(args.manifest),
        "pagesSha256": sha(args.pages),
        "runnerSha256": sha(__file__),
        "executionProvider": "CPUExecutionProvider",
        "headsEnabled": False,
        "referenceLabelsSuppliedToInference": False,
        "scope": "Private FP16 supervised plain recognition; not GPU or full-provider qualification",
    }
    receipt = args.out / "identity.json"
    if receipt.exists():
        assert json.loads(receipt.read_text()) == identity, "Resume identity mismatch"
    else:
        write_json(receipt, identity)
    sys.path.insert(0, manifest["runtimeRoot"])
    os.environ["PYTHONPATH"] = (
        manifest["runtimeRoot"] + os.pathsep + os.environ.get("PYTHONPATH", "")
    )
    os.environ["HOMR_MODEL_NAME"] = manifest["modelName"]
    os.environ["HOMR_REQUIRE_CUDA"] = "0"
    from homr_engine import HomrEngine

    engine = HomrEngine(
        use_gpu=False,
        homr_commit="b6eca7-plus-qualified-tremolo-patch",
        hard_timeout_seconds=280,
        startup_timeout_seconds=240,
        paired_tremolo_timing=False,
        structured_heads_path="",
        structured_export_families="none",
        expected_model_sha256={
            "encoder": manifest["graphs"]["encoder"]["sha256"],
            "decoder": manifest["graphs"]["decoder"]["sha256"],
            "segmentation": manifest["segmentation"]["sha256"],
        },
    )
    rows = []
    started_all = time.monotonic()
    try:
        engine.warm_up()
        for page in pages:
            image = Path(page["image"])
            assert sha(image) == page["image_sha256"], page["id"]
            folder = args.out / (page["score"] + "_" + page["id"].split(":")[-1])
            folder.mkdir(exist_ok=True)
            row_path = folder / "result.json"
            if row_path.exists():
                row = json.loads(row_path.read_text())
                assert row["id"] == page["id"] and row["imageSha256"] == sha(image)
                for name, expected in row.get("outputSha256", {}).items():
                    assert sha(folder / name) == expected
            else:
                started = time.monotonic()
                row = {
                    "id": page["id"],
                    "score": page["score"],
                    "imageSha256": sha(image),
                }
                try:
                    result = engine.transcribe(image.read_bytes(), image.suffix, False)
                    (folder / "score.musicxml").write_bytes(result["musicxml"])
                    write_json(folder / "review.json", result["review"])
                    row.update(
                        status="success",
                        outputSha256={
                            name: sha(folder / name)
                            for name in ("score.musicxml", "review.json")
                        },
                        staffCount=len(result["review"].get("staves", [])),
                    )
                except Exception as error:  # noqa: BLE001
                    row.update(
                        status="failed",
                        error=str(error),
                        errorType=type(error).__name__,
                    )
                row["seconds"] = time.monotonic() - started
                write_json(row_path, row)
            rows.append(row)
            write_json(
                args.out / "progress.json",
                {
                    "completed": len(rows),
                    "total": len(pages),
                    "pages": rows,
                    "secondsThisInvocation": time.monotonic() - started_all,
                },
            )
            print(json.dumps(row), flush=True)
    finally:
        engine.shutdown()
    write_json(
        args.out / "complete.json",
        {
            "completed": len(rows),
            "total": len(pages),
            "successes": sum(row["status"] == "success" for row in rows),
            "failures": sum(row["status"] != "success" for row in rows),
        },
    )


if __name__ == "__main__":
    main()
