"""Validate a browser review export and create a new local score-copy directory."""

import argparse
import json
from pathlib import Path

from lyric_placement_handoff import placement_handoff
from reviewed_lyric_xml import apply_reviewed_plan, sha_bytes


def import_copy(inventory, review, xml_bytes, score):
    plan = placement_handoff(inventory, review)
    if score not in {r["score"] for r in inventory}:
        raise ValueError("Score is not in the reviewed inventory")
    output, applied = apply_reviewed_plan(xml_bytes, plan, score)
    if not applied:
        raise ValueError("No fully confirmed placements for this score")
    receipt = {
        "automaticAttachment": False,
        "inputSha256": sha_bytes(xml_bytes),
        "outputSha256": sha_bytes(output),
        "score": score,
        "applied": applied,
        "allNonLyricContentUnchanged": True,
    }
    return output, plan, receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--xml", type=Path, required=True)
    parser.add_argument("--score", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    inventory_bytes = args.inventory.read_bytes()
    review_bytes = args.review.read_bytes()
    output, plan, receipt = import_copy(
        json.loads(inventory_bytes),
        json.loads(review_bytes),
        args.xml.read_bytes(),
        args.score,
    )
    receipt.update(
        inventorySha256=sha_bytes(inventory_bytes),
        reviewSha256=sha_bytes(review_bytes),
        sourceSha256=sha_bytes(Path(__file__).read_bytes()),
    )
    args.out_dir.mkdir(parents=True, exist_ok=False)
    (args.out_dir / "score.musicxml").write_bytes(output)
    (args.out_dir / "validated-plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (args.out_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
