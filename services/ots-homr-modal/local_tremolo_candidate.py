"""Isolated CPU HTTP candidate; no production identities, detectors or deployment."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from verify_tremolo_source_candidate import ARCHIVE_SHA256, HERE, PATCH_SHA256

MODEL_NAME = "local-tremolo-accepted-20261007"
HEAD_ROUTING_PATCH_SHA256 = (
    "365346a3b81988c342264f68d618f3a64364deff0f0661d571a5bd3ba0aead3a"
)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    archive = HERE / "source/homr-b6eca7-source.tar.gz"
    patch = HERE / "patches/homr-paired-tremolo-candidate.patch"
    assert sha(archive) == ARCHIVE_SHA256
    assert sha(patch) == PATCH_SHA256
    with tarfile.open(archive) as tar:
        tar.extractall(output, filter="data")
    root = output / "homr"
    source = {}
    for name in (
        "homr-runtime-glue.patch",
        "homr-paired-tremolo-candidate.patch",
        "homr-worker-head-routing-candidate.patch",
    ):
        path = HERE / "patches" / name
        if name == "homr-worker-head-routing-candidate.patch":
            assert sha(path) == HEAD_ROUTING_PATCH_SHA256
        subprocess.run(["git", "apply", "--check", str(path)], cwd=root, check=True)
        subprocess.run(["git", "apply", str(path)], cwd=root, check=True)
        source[name] = sha(path)
    graphs = json.loads(args.models.read_text())["accepted"]
    targets = {
        "encoder": f"encoder_{MODEL_NAME}.onnx",
        "decoder": f"decoder_{MODEL_NAME}.onnx",
        "heads": f"structured_heads_{MODEL_NAME}.onnx",
    }
    for role, name in targets.items():
        graph = graphs[role]
        assert sha(graph["path"]) == graph["sha256"]
        target = root / "homr/transformer" / name
        shutil.copyfile(graph["path"], target)
        graph["candidatePath"] = str(target)
    seg = root / "homr/segmentation" / args.segmentation.name
    shutil.copyfile(args.segmentation, seg)
    manifest = {
        "serviceRevision": "local-accepted-cpu-tremolo-20261007",
        "archiveSha256": ARCHIVE_SHA256,
        "patches": source,
        "runtimeRoot": str(root),
        "modelName": MODEL_NAME,
        "structuredExportFamilies": {
            "core": "none",
            "additional-heads": "beam,stem,tie,slur",
        },
        "graphs": graphs,
        "segmentation": {"path": str(seg), "sha256": sha(seg)},
        "scope": "Local CPU candidate, accepted experimental graphs, no detectors or shipping-provider equivalence",
    }
    manifest["runtimeSourceSha256"] = {
        str(path.relative_to(root)): sha(path)
        for path in sorted((root / "homr").rglob("*.py"))
    }
    manifest["serviceSourceSha256"] = {
        name: sha(HERE / name)
        for name in (
            "homr_engine.py",
            "ots_homr_provider.py",
            "local_tremolo_candidate.py",
        )
    }
    (output / "candidate.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output / "candidate.json")


class CandidateEngine:
    def __init__(self, manifest, enabled):
        from homr_engine import HomrEngine

        self.manifest = manifest
        self.enabled = enabled
        common = dict(
            use_gpu=False,
            homr_commit="b6eca7-plus-qualified-tremolo-patch",
            hard_timeout_seconds=280,
            startup_timeout_seconds=240,
            paired_tremolo_timing=enabled,
            expected_model_sha256={
                "encoder": manifest["graphs"]["encoder"]["sha256"],
                "decoder": manifest["graphs"]["decoder"]["sha256"],
                "segmentation": manifest["segmentation"]["sha256"],
            },
        )
        self.plain = HomrEngine(
            **common,
            structured_heads_path="",
            structured_export_families=manifest["structuredExportFamilies"]["core"],
        )
        self.heads = HomrEngine(
            **common,
            structured_heads_path=manifest["graphs"]["heads"]["candidatePath"],
            structured_export_families=manifest["structuredExportFamilies"][
                "additional-heads"
            ],
        )

    def warm_up(self):
        if self.is_ready():
            return
        self.plain.warm_up()
        self.heads.warm_up()

    def is_ready(self):
        return self.plain.is_ready() and self.heads.is_ready()

    def shutdown(self):
        self.plain.shutdown()
        self.heads.shutdown()

    def identity(self, detector):
        if detector != "none":
            raise ValueError("This local candidate has no text detector")
        result = {
            "executionProvider": "CPUExecutionProvider",
            "localCandidate": self.manifest,
            "notationPolicies": {
                "pairedTremoloTiming": "peer-span-v1" if self.enabled else "off"
            },
        }
        return result

    def capabilities_identity(self):
        return {**self.identity("none"), "textDetectors": []}

    def transcribe(
        self, page, content_type, detect_title, detector, score_profile=None
    ):
        self.identity(detector)
        if detect_title:
            raise ValueError("OCR is outside this candidate smoke scope")
        suffix = ".png" if content_type == "image/png" else ".jpg"
        return {
            "core": self.plain.transcribe(page, suffix, False, score_profile),
            "additional-heads": self.heads.transcribe(
                page, suffix, False, score_profile
            ),
        }

    def regenerate(self, staffs, title=""):
        return self.plain.regenerate(staffs, title)["musicxml"]

    def materialize_structured(self, staffs, structured, families, title=""):
        return self.heads.regenerate(
            staffs, title, structured=structured, families=families
        )["musicxml"]


def smoke(args):
    manifest = json.loads(args.manifest.read_text())
    root = Path(manifest["runtimeRoot"])
    for relative, expected in manifest["runtimeSourceSha256"].items():
        assert sha(root / relative) == expected
    for graph in manifest["graphs"].values():
        assert sha(graph["candidatePath"]) == graph["sha256"]
    assert sha(manifest["segmentation"]["path"]) == manifest["segmentation"]["sha256"]
    sys.path.insert(0, str(root))
    os.environ["PYTHONPATH"] = str(root) + os.pathsep + os.environ.get("PYTHONPATH", "")
    os.environ["HOMR_MODEL_NAME"] = manifest["modelName"]
    os.environ["HOMR_REQUIRE_CUDA"] = "0"
    from fastapi.testclient import TestClient
    from ots_homr_provider import create_provider_app

    engine = CandidateEngine(manifest, args.enabled)
    output = args.output
    output.mkdir(parents=True, exist_ok=False)
    job_started = time.monotonic()
    started = job_started
    engine.warm_up()
    warmup = time.monotonic() - started
    app = create_provider_app(
        engine=engine,
        service_revision=manifest["serviceRevision"],
        provider_token="local-candidate-test",
    )
    report = {
        "identity": engine.identity("none"),
        "enabled": args.enabled,
        "warmupSeconds": warmup,
        "pages": [],
    }
    try:
        with TestClient(app) as client:
            for page in json.loads(args.pages.read_text()):
                image = Path(page["image"])
                started = time.monotonic()
                response = client.post(
                    "/v1/scan-page",
                    files={"page": (image.name, image.read_bytes(), "image/png")},
                    data={"textDetector": "none", "detectTitle": "false"},
                    headers={
                        "Authorization": "Bearer local-candidate-test",
                        "Idempotency-Key": sha(image),
                    },
                )
                row = {
                    "score": page["score"],
                    "imageSha256": sha(image),
                    "seconds": time.monotonic() - started,
                    "status": response.status_code,
                }
                (output / f'{page["score"]}.json').write_text(response.text)
                report["pages"].append(row)
                (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
                print(json.dumps(row), flush=True)
                response.raise_for_status()
    finally:
        engine.shutdown()
    (output / "complete.json").write_text(
        json.dumps({"success": True, "seconds": time.monotonic() - job_started})
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare")
    p.add_argument("--models", type=Path, required=True)
    p.add_argument("--segmentation", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("smoke")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--pages", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--enabled", action="store_true")
    args = parser.parse_args()
    (prepare if args.command == "prepare" else smoke)(args)


if __name__ == "__main__":
    main()
