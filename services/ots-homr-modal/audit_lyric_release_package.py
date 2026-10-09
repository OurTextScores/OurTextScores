"""Read-only local artifact/source audit; does not contact or deploy Modal."""

import argparse
import ast
import hashlib
import json
from pathlib import Path

from calibration_manifest import load_calibration_manifest
from pins import CORE_SHA256, DETECTORS, LOGICAL_DETECTORS
from semantic_gate import DEFAULT_MODEL, MODEL_SHA256


def sha(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256")
    return digest.hexdigest()


def check(path, expected, label):
    actual = sha(path) if path.is_file() else None
    return {
        "label": label,
        "path": str(path),
        "expectedSha256": expected,
        "actualSha256": actual,
        "matches": actual == expected,
    }


def literal_constants(path):
    result = {}
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    result[target.id] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    constants = literal_constants(here / "modal_app.py")
    root = args.base / "c2-latency-20260925/models/ots-homr"
    checks = [
        check(
            here / "source/homr-b6eca7-source.tar.gz",
            constants["SOURCE_ARCHIVE_SHA256"],
            "service source archive",
        ),
        check(DEFAULT_MODEL, MODEL_SHA256, "semantic classifier"),
    ]
    for name, (repo, revision, filename, digest) in DETECTORS.items():
        checks.append(
            {
                **check(root / repo.replace("/", "--") / filename, digest, name),
                "revision": revision,
            }
        )
    for filename, digest in CORE_SHA256.items():
        checks.append(
            check(root / "jhlusko--OTS-homr" / filename, digest, "core " + filename)
        )
    calibration_path = here / "calibration/fusion-v1.json"
    calibration = load_calibration_manifest(calibration_path)
    for logical, (repo, revision, filename, digest) in LOGICAL_DETECTORS.items():
        calibration.assert_detector_matches(logical, sha256=digest, revision=revision)
        identity = calibration.detectors[logical]
        if identity.repository != repo or identity.artifact != filename:
            raise ValueError("Calibration repository/artifact mismatch")
    candidate = json.loads(args.candidate.read_text())
    for name, graph in candidate["graphs"].items():
        for key in ["path", "candidatePath"]:
            checks.append(
                check(
                    Path(graph[key]), graph["sha256"], "candidate " + name + " " + key
                )
            )
    runtime_root = Path(candidate["runtimeRoot"])
    runtime = [
        check(runtime_root / relative, digest, "runtime " + relative)
        for relative, digest in candidate["runtimeSourceSha256"].items()
    ]
    binding_audits = []
    for folder in [
        "lyric-prepared-full25-20261008",
        "lyric-context-additional8-20261008",
    ]:
        replay = args.base / folder
        binding_path = replay / "fusion/input-binding.json"
        binding = json.loads(binding_path.read_text())
        changed = []
        for path, expected in binding.items():
            path = Path(path)
            if path.is_file() and sha(path) == expected:
                continue
            snapshots = list((replay / "source-snapshot").rglob(path.name))
            changed.append(
                {
                    "path": str(path),
                    "expectedSha256": expected,
                    "preservedMatchingSnapshot": next(
                        (str(p) for p in snapshots if sha(p) == expected), None
                    ),
                }
            )
        binding_audits.append(
            {
                "replay": folder,
                "bindingSha256": sha(binding_path),
                "entries": len(binding),
                "currentMismatchCount": len(changed),
                "changes": changed,
            }
        )
    report = {
        "scope": "Local source/artifact verification, not a deployment-readiness certificate. Prepared recognition used private CPU FP16 plain core with notation heads disabled; it does not qualify final GPU/provider/structured-head stack. Context policies remain offline.",
        "serviceRevision": constants["SERVICE_REVISION"],
        "homrCommit": constants["HOMR_COMMIT"],
        "calibrationPolicyRevision": calibration.policy_revision,
        "calibrationManifestSha256": sha(calibration_path),
        "calibrationBindsDetectorSource": False,
        "calibrationSourceCaveat": "Manifest pins weights and policy body, not confidence extraction source. Corrected component scores require explicit source binding/requalification before promotion.",
        "checks": checks,
        "candidateRuntimeSources": runtime,
        "fusionBindings": binding_audits,
        "inputSha256": {
            str(p): sha(p)
            for p in [
                Path(__file__),
                here / "pins.py",
                here / "modal_app.py",
                args.candidate,
            ]
        },
        "failedArtifactChecks": sum(not c["matches"] for c in checks),
        "failedRuntimeSourceChecks": sum(not c["matches"] for c in runtime),
    }
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: report[k]
                for k in [
                    "failedArtifactChecks",
                    "failedRuntimeSourceChecks",
                    "fusionBindings",
                ]
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
