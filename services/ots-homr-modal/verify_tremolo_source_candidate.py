"""Verify the isolated source candidate without model loads or environment installs."""

import argparse
import hashlib
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARCHIVE_SHA256 = "999d5071fe9bcfab8dc1534ec1614e125888651fcc6c72a9862bc605ba38d1a2"
PATCH_SHA256 = "5bbfe5c35e0e6f68526f4e4dd3eb373ae1808e86a53974ac077eb88a06f12da0"
PROBE = r"""
import sys, json, hashlib, xml.etree.ElementTree as ET
sys.path.insert(0, sys.argv[1])
from homr.music_xml_generator import XmlGeneratorArguments, generate_xml
from homr.transformer.vocabulary import EncodedSymbol
results = {}
for case in ("paired", "ordinary", "single", "changing"):
    target, peer = [], []
    for bar in range(4):
        if case == "changing":
            target.extend([EncodedSymbol("timeSignatureBeats_4" if bar < 2 else "timeSignatureBeats_3", ".", ".", ".", ".", "."), EncodedSymbol("timeSignature/4", ".", ".", ".", ".", ".")])
        for pitch in ("C4", "E4", "D4", "F4"):
            paired = case in ("paired", "changing") and bar == 0
            art = "tremolo" if (paired or case == "single") else "_"
            target.append(EncodedSymbol("note_2" if paired else "note_4", pitch, "_", art, "_", "upper"))
            peer.append(EncodedSymbol("note_4", "G4", "_", "_", "_", "upper"))
        target.append(EncodedSymbol("barline", ".", ".", ".", ".", "."))
        peer.append(EncodedSymbol("barline", ".", ".", ".", ".", "."))
    args = XmlGeneratorArguments() if sys.argv[2] == "baseline" else XmlGeneratorArguments(paired_tremolo_timing=sys.argv[2] == "on")
    xml = ET.tostring(generate_xml(args, [target, peer], "Source candidate probe"))
    results[case] = hashlib.sha256(xml).hexdigest()
print(json.dumps(results))
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, help="Existing HOMR-capable Python")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    archive = HERE / "source/homr-b6eca7-source.tar.gz"
    patch = HERE / "patches/homr-paired-tremolo-candidate.patch"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == PATCH_SHA256
    with tempfile.TemporaryDirectory(prefix="homr-tremolo-source-") as directory:
        with tarfile.open(archive) as tar:
            tar.extractall(directory, filter="data")
        root = Path(directory) / "homr"
        for operation in ("--check", None):
            command = ["git", "apply"]
            if operation:
                command.append(operation)
            subprocess.run(
                command + [str(HERE / "patches/homr-runtime-glue.patch")],
                cwd=root,
                check=True,
            )

        def probe(mode):
            import os

            env = dict(os.environ, HOMR_PAIRED_TREMOLO_TIMING="0")
            result = subprocess.run(
                [args.python, "-c", PROBE, str(root), mode],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            return json.loads(result.stdout)

        baseline = probe("baseline")
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=root, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=root, check=True)
        off, on = probe("off"), probe("on")
        assert off == baseline, "Disabled candidate changes pinned-base output"
        assert on["paired"] != off["paired"], "Positive candidate did not activate"
        for case in ("ordinary", "single", "changing"):
            assert on[case] == off[case], f"Guard changed {case} output"
    report = {
        "archiveSha256": ARCHIVE_SHA256,
        "candidatePatchSha256": PATCH_SHA256,
        "baseline": baseline,
        "disabled": off,
        "enabled": on,
        "scope": "Four synthetic exporter probes; no model-loaded scan or corpus accuracy claim",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"Clean application, four disabled parity checks and three guard checks passed: {args.output}"
    )


if __name__ == "__main__":
    main()
