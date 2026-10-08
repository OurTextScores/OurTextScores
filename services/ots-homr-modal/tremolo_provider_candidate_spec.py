"""Write a verified separate provider build specification; never deploys."""

import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_NAME = "ourtextscores-ots-homr-tremolo-candidate"
SERVICE_REVISION = "ots-homr-tremolo-candidate-20261007-v1"
SOURCE_INPUTS = {
    "source/homr-b6eca7-source.tar.gz": "999d5071fe9bcfab8dc1534ec1614e125888651fcc6c72a9862bc605ba38d1a2",
    "patches/homr-runtime-glue.patch": "954fa4e8136c871830896d9efdd3c690100e876f9512f10c6ed7462698919100",
    "patches/homr-paired-tremolo-candidate.patch": "5bbfe5c35e0e6f68526f4e4dd3eb373ae1808e86a53974ac077eb88a06f12da0",
    "patches/homr-worker-head-routing-candidate.patch": "365346a3b81988c342264f68d618f3a64364deff0f0661d571a5bd3ba0aead3a",
}
FAMILIES = {"core": "none", "additional-heads": "beam,stem,tie,slur"}
EXPERIMENTAL_GRAPHS = {
    "encoder": "6bf67afd93316444c2e15036f8bcbc1a4e26bc7972e179b3cd9ba6de0c99d0fa",
    "decoder": "cddbb22fa8be3b6e5e9f9ae1f602f80549db8fe0d06e4e3954e20295f1dd139b",
    "heads": "80f2efbcc85e01626dd6a127b2c925538e76f42bd9d598e6a032d5d05e2e0bf5",
}


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def specification(manifest, source_root=HERE):
    """Lock the qualified experimental stack, rejecting another graph family."""
    for relative, expected in SOURCE_INPUTS.items():
        if sha(source_root / relative) != expected:
            raise ValueError(f"Source input hash mismatch: {relative}")
    if (
        manifest.get("archiveSha256")
        != SOURCE_INPUTS["source/homr-b6eca7-source.tar.gz"]
    ):
        raise ValueError("Candidate archive identity differs")
    expected_patches = {
        Path(relative).name: digest
        for relative, digest in SOURCE_INPUTS.items()
        if relative.startswith("patches/")
    }
    if manifest.get("patches") != expected_patches:
        raise ValueError("Candidate patch identities differ")
    if manifest.get("structuredExportFamilies") != FAMILIES:
        raise ValueError(
            "Candidate must exclude rhythmic advance and disable core heads"
        )
    graphs = {}
    for role, expected in EXPERIMENTAL_GRAPHS.items():
        graph = manifest["graphs"][role]
        if graph["sha256"] != expected or sha(graph["candidatePath"]) != expected:
            raise ValueError(f"Experimental graph identity mismatch: {role}")
        graphs[role] = {"path": graph["candidatePath"], "sha256": expected}
    runtime_root = Path(manifest["runtimeRoot"])
    runtime_sources = manifest["runtimeSourceSha256"]
    actual_sources = {
        str(path.relative_to(runtime_root))
        for path in (runtime_root / "homr").rglob("*.py")
    }
    if actual_sources != set(runtime_sources):
        raise ValueError("Runtime source inventory differs")
    for relative, expected in runtime_sources.items():
        if sha(runtime_root / relative) != expected:
            raise ValueError(f"Runtime source hash mismatch: {relative}")
    segmentation = manifest["segmentation"]
    if sha(segmentation["path"]) != segmentation["sha256"]:
        raise ValueError("Segmentation hash mismatch")
    service_sources = {
        name: sha(source_root / name)
        for name in (
            "homr_engine.py",
            "ots_homr_provider.py",
            "local_tremolo_candidate.py",
            "tremolo_provider_candidate_spec.py",
        )
    }
    return {
        "schemaVersion": 1,
        "appName": APP_NAME,
        "serviceRevision": SERVICE_REVISION,
        "deploymentStatus": "not-built-or-deployed",
        "graphFamily": "accepted-experimental-fp32-not-shipping-fp16",
        "sourceInputs": SOURCE_INPUTS,
        "runtimeSourceSha256": runtime_sources,
        "serviceSourceSha256": service_sources,
        "graphs": graphs,
        "segmentation": segmentation,
        "workers": {
            "core": {
                "structuredHeadsPath": "",
                "structuredExportFamilies": FAMILIES["core"],
            },
            "additional-heads": {
                "structuredHeadsPath": graphs["heads"]["path"],
                "structuredExportFamilies": FAMILIES["additional-heads"],
            },
        },
        "pairedTremoloTiming": {"control": False, "candidate": True},
        "httpHardTimeoutSeconds": 280,
        "remainingGates": [
            "Fresh negative controls with these exact policies",
            "Build separate image from verified source; do not reuse shipping runtime",
            "Qualify OCR and calibrated text fusion on full production GPU path",
            "Measure full page latency against 280-second budget",
            "Separately qualify shipping fp16 graphs before any equivalence claim",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = specification(json.loads(args.manifest.read_text()))
    with args.output.open("x") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
