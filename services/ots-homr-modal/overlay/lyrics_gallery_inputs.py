"""Turn accept-all results into the inputs of the lyrics-and-staff-text gallery.

Reads <page>__scan.musicxml / <page>__reviewed.musicxml pairs (accept_all.cjs) for pages of the core's validation songs,
runs both through the provider's markup repair (so they show what the product returns), counts what accepting everything
added, keeps the pages that gained lyrics and at least one direction or dynamic, takes the first --count by a fixed hash
order, and writes them with a manifest where build_overlay_gallery.py --only-review expects them.
"""

import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from markup_repair import repair_musicxml


def count(root):
    lyrics = sum(1 for _ in root.iter("lyric"))
    directions = [d for d in root.iter("direction") if (d.get("id") or "").startswith("ots-review")]
    words = sum(1 for d in directions if d.find(".//words") is not None)
    dynamics = sum(1 for d in directions if d.find(".//dynamics") is not None)
    return lyrics, words, dynamics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reviewed", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="<public>/devs-assets/ots-homr-lyrics")
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--seed", default="20261017")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("*"):
        if old.is_file():
            old.unlink()
    rows = []
    for reviewed in sorted(args.reviewed.glob("*__reviewed.musicxml")):
        page = reviewed.name.split("__")[0]
        scan = reviewed.with_name(f"{page}__scan.musicxml")
        before, after = repair_musicxml(scan.read_bytes(), drop_beams=True)[0], repair_musicxml(reviewed.read_bytes(), drop_beams=True)[0]
        a, b = count(ET.fromstring(before)), count(ET.fromstring(after))
        rows.append({"id": page, "lyricsAdded": b[0] - a[0], "wordsAdded": b[1] - a[1], "dynamicsAdded": b[2] - a[2], "_scan": before, "_reviewed": after})
    eligible = [r for r in rows if r["lyricsAdded"] >= 1 and r["wordsAdded"] + r["dynamicsAdded"] >= 1]
    picked = sorted(eligible, key=lambda r: hashlib.sha256(f"{args.seed}:{r['id']}".encode()).hexdigest())[: args.count]
    cases = []
    for r in picked:
        (args.out / f"{r['id']}__scan.musicxml").write_bytes(r["_scan"])
        (args.out / f"{r['id']}__reviewed.musicxml").write_bytes(r["_reviewed"])
        cases.append({k: r[k] for k in ("id", "lyricsAdded", "wordsAdded", "dynamicsAdded")} | {"left": f"{r['id']}__scan.musicxml", "right": f"{r['id']}__reviewed.musicxml"})
    summary = {"pagesWithSuggestions": len(rows), "eligible": len(eligible), **{k: sum(r[k] for r in rows) for k in ("lyricsAdded", "wordsAdded", "dynamicsAdded")}}
    (args.out / "manifest.json").write_text(json.dumps({"summary": summary, "cases": cases}, indent=1))
    print(summary, [c["id"] for c in cases])


if __name__ == "__main__":
    main()
