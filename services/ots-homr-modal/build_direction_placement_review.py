"""Build the placement judgement page from real scanner jobs: one item per offered direction/dynamic row.

Reads each job's lyric-candidate inventory and the placement crop (orange row, numbered notes, blue proposal)
from the running OTS backend, so what is judged is exactly what the review page shows. Rows with no note
choice are counted in the key but cannot be judged (the reviewer would pick a note by hand).
"""

import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path


def get(url, token):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True, help="scanned.jsonl: {image, jobId} per line")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    token = os.environ["OTS_TOKEN"]
    args.out.mkdir(parents=True, exist_ok=False)
    items, key = [], []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        base = f"{args.api}/{job['jobId']}/pages/1/lyric-candidates"
        inventory = json.loads(get(base, token))
        for row in inventory["ocrRows"]:
            if row.get("kind") not in ("words", "dynamic"):
                continue
            anchor = row.get("anchor") or {}
            syllable = (anchor.get("syllables") or [{}])[0]
            choice = next((c for c in row.get("noteChoices") or [] if c["noteId"] == syllable.get("noteId")), None)
            record = {"id": hashlib.sha256(f"{job['jobId']}:{row['id']}".encode()).hexdigest()[:16], "image": job["image"], "jobId": job["jobId"], "rowId": row["id"], "kind": row["kind"], "text": row.get("mark") or row["text"], "offered": bool(row.get("proposedDirection")), "withheld": row.get("withheldReason"), "noteChoices": len(row.get("noteChoices") or []), "proposedNote": choice, "placement": anchor.get("placement")}
            key.append(record)
            if not record["offered"] or not choice:
                continue
            name = f"{record['id']}.png"
            (args.out / name).write_bytes(get(f"{base}/{row['id']}/crop?view=placement", token))
            items.append({"id": record["id"], "image": name, "kind": row["kind"], "text": record["text"], "note": f"{choice['pitch']}, measure {choice['measure']}" + (f" ({choice['hand']} hand)" if choice.get("hand") else ""), "placement": record["placement"] or "above"})
    items.sort(key=lambda i: hashlib.sha256(("order" + i["id"]).encode()).hexdigest())
    (args.out / "items.json").write_text(json.dumps(items))
    (args.out / "index.html").write_bytes(Path(__file__).with_name("direction_placement_review.html").read_bytes())
    args.out.with_name(args.out.name + "-key.json").write_text(json.dumps(key, indent=1))
    offered = [r for r in key if r["offered"]]
    print(len(items), "judgeable items;", len(offered), "offered rows;", sum(1 for r in offered if not r["noteChoices"]), "offered without any note choice;", len(args.jobs.read_text().splitlines()), "jobs")


if __name__ == "__main__":
    main()
