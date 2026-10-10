"""Build the pinned fusion-v1 manifest from a lyric calibration fit report.

Lyrics (e2) are calibrated and may be auto-accepted at the fitted line. Directions and dynamics (e4)
are pinned but deliberately uncalibrated, so they always stay in review. The policyRevision is the
digest of the manifest without it, exactly as `calibration_manifest.load_calibration_manifest` checks.
"""

import argparse
import hashlib
import json
from pathlib import Path

from confidence_extraction import confidence_extraction_identity
from fusion_policy import CLASS_ALLOWLIST
from pins import FUSION_DETECTORS, LOGICAL_DETECTORS

SCHEMA_VERSION = "ots.text-fusion-calibration.v1"


def build(report, created_at, supersedes=None):
    if report.get("schemaVersion") != "ots.lyric-calibration-fit.v1":
        raise ValueError("Unsupported fit report")
    if report["acceptLowerEdge"] is None:
        raise ValueError("The fit reached no band at the target precision; no accept line exists")
    bands = [b for b in report["bands"] if b.get("calibrated") is not None]
    accept_band = next(b for b in bands if b["lowerEdge"] == report["acceptLowerEdge"])
    body = {
        "schemaVersion": SCHEMA_VERSION,
        "policy": "fusion-v1",
        "createdAt": created_at,
        "note": (
            "Lyrics (e2) are calibrated against OCR-confirmed positives and a sampled human "
            "judgement of unmatched boxes; directions and dynamics (e4) are pinned but uncalibrated, "
            "so they always stay in review."
        ),
        # The scores the bins were fitted on were produced by this extraction; the provider refuses to apply the
        # bins to any other (see calibration_manifest.assert_extraction_matches).
        "confidenceExtraction": {
            key: value
            for key, value in confidence_extraction_identity().items()
            if key in ("id", "sourceSha256")
        },
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
        "calibration": {
            "lyrics": {
                "Lyrics": {
                    "kind": "isotonic-binned",
                    "belowLowestEdge": None,
                    "binLowerEdges": [b["lowerEdge"] for b in bands],
                    "binValues": [b["calibrated"] for b in bands],
                    "note": "Estimated probability that an e2 box is lyric text on a vocal page.",
                }
            }
        },
        "accept": {
            "lyrics": {"Lyrics": accept_band["calibrated"]},
            "non-lyric-text": {label: None for label in sorted(CLASS_ALLOWLIST["non-lyric-text"])},
            "dynamics": {"Dynamic": None},
        },
        "geometry": {
            "iouThreshold": 0.3,
            "containmentThreshold": 0.6,
            "minBoxArea": report["sizeGate"]["minBoxArea"],
            "maxPageAreaFraction": report["sizeGate"]["maxPageAreaFraction"],
        },
        "minimumWinnerMargin": 0.0,
        "fit": {
            "targetPrecision": report["targetPrecision"],
            "acceptRawLowerEdge": report["acceptLowerEdge"],
            "acceptChoice": report["acceptChoice"],
            "pages": report["pages"],
            "negativeRates": report["negativeRates"],
            "definition": report["definition"],
            "tallBoxProxy": report["tallBoxProxy"],
            "caveats": report["caveats"],
            # Set when this manifest replaces one fitted on a different confidence extraction.
            **({"supersedes": supersedes} if supersedes else {}),
        },
    }
    revision = hashlib.sha256(json.dumps(body, indent=1, sort_keys=True).encode()).hexdigest()
    return {**body, "policyRevision": revision}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fit", type=Path, required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--supersedes", help="policyRevision of the manifest this one replaces")
    args = parser.parse_args()
    manifest = build(json.loads(args.fit.read_text()), args.created_at, args.supersedes)
    with args.out.open("x") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
    print(manifest["policyRevision"])
