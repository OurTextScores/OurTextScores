"""Prepare isolated private-fp16 CPU smoke inputs; no inference/downloads."""

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

from local_tremolo_candidate import prepare, sha
from pins import HEADS_ONNX_SHA256, MANIFEST_SHA256, TRAINING_REVISION
from preflight_tremolo_private_candidate import preflight
from runtime_identity import load_structured_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--segmentation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    inventory = preflight(args.models_root.resolve())
    if not all(row["verified"] for row in inventory["files"].values()):
        raise ValueError("Private runtime inputs are missing or mismatched")
    published = load_structured_manifest(
        Path(inventory["files"]["heads-manifest"]["path"]),
        expected_sha256=MANIFEST_SHA256,
        core_training_revision=TRAINING_REVISION,
    )
    if published["runtimeArtifacts"]["onnx"]["sha256"] != HEADS_ONNX_SHA256:
        raise ValueError("Published sidecar compatibility differs")
    # Use a temporary metadata file beside the output, without changing the
    # existing prepare driver or any shipping graph files.
    metadata = args.output.with_name(args.output.name + "-graphs.json")
    with metadata.open("x") as stream:
        json.dump(
            {
                "accepted": {
                    role: {"path": row["path"], "sha256": row["expectedSha256"]}
                    for role, row in inventory["files"].items()
                    if role in ("encoder", "decoder", "heads")
                }
            },
            stream,
        )
    prepare(
        SimpleNamespace(
            output=args.output, models=metadata, segmentation=args.segmentation
        )
    )
    path = args.output / "candidate.json"
    manifest = json.loads(path.read_text())
    model_name = "local-private-fp16-tremolo-20261007"
    for role, graph in manifest["graphs"].items():
        old = Path(graph["candidatePath"])
        prefix = "structured_heads" if role == "heads" else role
        target = old.with_name(f"{prefix}_{model_name}.onnx")
        old.rename(target)
        graph["candidatePath"] = str(target)
    manifest["serviceSourceSha256"][Path(__file__).name] = sha(Path(__file__))
    manifest["modelName"] = model_name
    manifest["serviceRevision"] = "local-private-fp16-cpu-tremolo-20261007"
    manifest["graphFamily"] = "shipping-private-fp16"
    manifest["scope"] = (
        "Private pinned graph CPU HTTP smoke; no OCR/detectors/fusion/GPU latency or experimental fp32 equivalence"
    )
    manifest["privatePinInventory"] = inventory
    manifest["publishedHeadManifest"] = published
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(path)


if __name__ == "__main__":
    main()
