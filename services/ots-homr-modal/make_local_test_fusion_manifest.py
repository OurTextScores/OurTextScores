"""Write an UNCALIBRATED, local-test fusion-v1 manifest pinned to the shipping detectors.

It exists so a separate test provider can exercise the fusion path and emit real detector
boxes. It carries no calibration table and no accept thresholds, so every region lands in
`review`; it is NOT a release calibration and must never be copied to calibration/fusion-v1.json.
"""

import argparse
import hashlib
import json
from pathlib import Path

from fusion_policy import CLASS_ALLOWLIST
from pins import FUSION_DETECTORS, LOGICAL_DETECTORS

SCHEMA_VERSION = "ots.text-fusion-calibration.v1"


def build():
    body = {
        "schemaVersion": SCHEMA_VERSION,
        "policy": "fusion-v1",
        "note": (
            "Uncalibrated local test. No calibration or accept thresholds, so nothing is "
            "ever auto-accepted; every region is review. Not a release calibration."
        ),
        "detectors": {
            detector_id: {
                "repository": LOGICAL_DETECTORS[detector_id][0],
                "revision": LOGICAL_DETECTORS[detector_id][1],
                "artifact": LOGICAL_DETECTORS[detector_id][2],
                "sha256": LOGICAL_DETECTORS[detector_id][3],
                "classAllowlist": sorted(CLASS_ALLOWLIST[detector_id]),
            }
            for detector_id in FUSION_DETECTORS
        },
        "calibration": {},
        "accept": {},
        "geometry": {"iouThreshold": 0.3, "containmentThreshold": 0.6},
        "minimumWinnerMargin": 0.0,
    }
    revision = hashlib.sha256(json.dumps(body, indent=1, sort_keys=True).encode()).hexdigest()
    return {**body, "policyRevision": revision}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = build()
    with args.out.open("x") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
    print(manifest["policyRevision"])
