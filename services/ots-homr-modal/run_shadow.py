"""Run a calibrated policy over real pages and record what it would have done.

Reads detector output that has already been computed (a `calib4a`-style results file),
so a shadow run costs no inference and can be repeated whenever a threshold moves. The
report it writes is the thing to read before promoting a policy: not the acceptance
count, which only says the pipeline ran, but the reasons beside every withholding.
"""

# flake8: noqa: T201

import argparse
import json
from collections import Counter
from pathlib import Path

from calibration_manifest import load_calibration_manifest
from shadow_fusion import shadow_page, shadow_totals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--results", type=Path, required=True, help="calib4a results JSON")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--detector", default="lyrics")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    manifest = load_calibration_manifest(args.manifest)
    rows = json.loads(args.results.read_text())

    reports = []
    for row in rows:
        boxes = [
            ("Lyrics", tuple(box), confidence)
            for box, confidence in zip(row.get("pred_boxes", []), row["pred_conf"])
        ]
        height, width = row["page_shape"]
        reports.append(
            shadow_page(
                page=f"{row['score_id']}/{row['page']}",
                detector_id=args.detector,
                boxes=boxes,
                manifest=manifest,
                page_size=(width, height),
            )
        )

    totals = shadow_totals(reports)
    print(f"policy {manifest.policy} @ {manifest.policy_revision[:12]}")
    print(f"pages {len(reports)}")
    for key in sorted(totals):
        print(f"  {key:34s} {totals[key]}")

    # What a reviewer would face: the pages where the policy proposes nothing, and the
    # pages where it proposes a lot, are both worth looking at before promotion.
    per_page = Counter(len(r.accepted) for r in reports)
    print("accepted per page:", dict(sorted(per_page.items())))
    kinds = Counter(k for r in reports for k in (["vocal"] if r.accepted else ["none"]))
    print("pages with at least one acceptance:", kinds.get("vocal", 0), "of", len(reports))

    if args.out:
        args.out.write_text(
            json.dumps(
                {
                    "policy": manifest.policy,
                    "policyRevision": manifest.policy_revision,
                    "totals": totals,
                    "pages": [
                        {
                            "page": r.page,
                            "counts": r.counts(),
                            "accepted": [
                                {
                                    "label": d.label,
                                    "box": list(d.box),
                                    "raw": round(d.raw_confidence, 4),
                                    "calibrated": d.calibrated_confidence,
                                }
                                for d in r.accepted
                            ],
                        }
                        for r in reports
                    ],
                },
                indent=1,
            )
        )
        print("wrote", args.out)


if __name__ == "__main__":
    main()
