"""Judging page for rows the scanner offers as unplaced (read, but no note near): are they real, and read correctly?

Uses the same Correct / Fix text / Not a direction / Unsure page as the direction-row judgement; each item is the placement
crop the review page shows (orange row box, numbered notes). The note is not judged here (the reviewer chooses it).
"""

import argparse
import hashlib
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
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    args.out.mkdir(parents=True, exist_ok=False)
    items, key = [], []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        base = f"{args.api}/{job['jobId']}/pages/1/lyric-candidates"
        for row in json.loads(get(base, token))["ocrRows"]:
            if not row.get("unplaced"):
                continue
            digest = hashlib.sha256(f"{job['jobId']}:{row['id']}".encode()).hexdigest()[:16]
            (args.out / f"{digest}.png").write_bytes(get(f"{base}/{row['id']}/crop?view=placement", token))
            text = row.get("mark") or row["text"]
            items.append({"id": digest, "image": f"{digest}.png", "kind": row["kind"], "text": text})
            key.append({"id": digest, "jobId": job["jobId"], "rowId": row["id"], "image": job["image"], "kind": row["kind"], "text": row["text"], "source": row.get("source") or "ocr", "choices": len(row.get("noteChoices") or [])})
    items.sort(key=lambda i: hashlib.sha256(("order" + i["id"]).encode()).hexdigest())
    (args.out / "items.json").write_text(json.dumps(items))
    (args.out / "index.html").write_bytes(Path(__file__).with_name("direction_judgement_review.html").read_bytes())
    args.out.with_name(args.out.name + "-key.json").write_text(json.dumps(key, indent=1))
    print(len(items), "unplaced rows")


if __name__ == "__main__":
    main()
