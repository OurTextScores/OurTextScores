"""What the scanner suggests as lyrics on instrumental (lyric-free) pages, after its own filtering.

Reads each scanner job's lyric-candidate inventory: OCR rows of kind lyric, how many the gate proposed and how many
the backend then withheld (footer, no staff, credit-like, far from notes), plus the fusion regions (accepted or
review). On a verified lyric-free page every suggested lyric row is a false suggestion.
"""

import argparse
import collections
import json
import os
import urllib.request
from pathlib import Path


def get(url, token):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}), timeout=120) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--crops", type=Path)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    if args.crops:
        args.crops.mkdir(parents=True, exist_ok=True)
    pages, totals = [], collections.Counter()
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        base = f"{args.api}/{job['jobId']}/pages/1/lyric-candidates"
        inventory = json.loads(get(base, token))
        lyric_rows = [r for r in inventory["ocrRows"] if r.get("kind") in (None, "lyric")]
        suggested = [r for r in lyric_rows if r.get("proposedLyric")]
        withheld = [r for r in lyric_rows if not r.get("proposedLyric") and r.get("withheldReason")]
        gate_lyric = [r for r in lyric_rows if r.get("semantic") == "Lyrics"]
        regions = collections.Counter(c["regionStatus"] for c in inventory.get("candidates", []))
        name = Path(job["image"]).name
        page = {"page": name, "score": name.split("_")[0].replace("B-", "").replace("test-", "").split("-")[0] if name.startswith(("B-", "test-")) else name.split("_")[0], "jobId": job["jobId"], "lyricRows": len(lyric_rows), "gateLyricRows": len(gate_lyric), "suggested": len(suggested), "withheld": len(withheld), "withheldReasons": dict(collections.Counter(r["withheldReason"] for r in withheld)), "regions": dict(regions), "suggestedText": [r["text"] for r in suggested][:12]}
        pages.append(page)
        totals["pages"] += 1
        totals["pagesWithSuggestion"] += bool(suggested)
        totals["suggested"] += len(suggested)
        totals["lyricRows"] += len(lyric_rows)
        totals["gateLyricRows"] += len(gate_lyric)
        totals["acceptedRegions"] += regions.get("accepted", 0)
        totals["reviewRegions"] += regions.get("review", 0)
        if args.crops:
            for r in suggested[:3]:
                try:
                    (args.crops / f"{name[:-4]}-{r['id'][:8]}.png").write_bytes(get(f"{base}/{r['id']}/crop", token))
                except Exception:  # noqa: BLE001
                    pass
    args.out.write_text(json.dumps({"totals": dict(totals), "pages": pages}, indent=1))
    print(dict(totals))
    by_score = collections.defaultdict(lambda: [0, 0, 0])
    for p in pages:
        s = by_score[p["score"]]
        s[0] += 1
        s[1] += p["suggested"]
        s[2] += p["suggested"] > 0
    print("per score (pages, suggested rows, pages with a suggestion):", {k: tuple(v) for k, v in sorted(by_score.items())})


if __name__ == "__main__":
    main()
