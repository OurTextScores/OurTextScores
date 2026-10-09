"""Replay an unshipped lyric-line context rule against frozen prepared inputs."""

import argparse
import hashlib
import json
from pathlib import Path

from lyric_line_context_diagnostic import lyric_line_context
from semantic_gate import SemanticGate


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--minimum-peers", type=int, choices=[1, 2], default=2)
    args = parser.parse_args()
    source = Path(__file__).parent
    replay = args.base / "lyric-prepared-full25-20261008"
    ocr = replay / "ocr/rows.jsonl"
    pages = [json.loads(line) for line in ocr.read_text().splitlines()]
    binding = {
        str(p): sha(p)
        for p in [
            Path(__file__),
            source / "lyric_line_context_diagnostic.py",
            source / "semantic_gate.py",
            source / "models/semantic-lyrics-v1.json",
            ocr,
            replay / "filtered/report.json",
        ]
    }
    gate = SemanticGate.load()
    changes = []
    for page in pages:
        path = (
            replay
            / "filtered"
            / (page["score"] + "_" + page["id"].split(":")[-1] + ".json")
        )
        binding[str(path)] = sha(path)
        original = json.loads(path.read_text())["ocrRows"]
        lookup = {tuple(row["box"]): row for row in original}
        for row in page["rows"]:
            candidate = lookup[tuple(row["box"])]
            evidence = lyric_line_context(candidate, original, gate, args.minimum_peers)
            if evidence:
                changes.append(
                    {
                        "pageId": page["id"],
                        "corpus": page["corpus"],
                        "candidateId": candidate["id"],
                        "text": row["text"],
                        "box": row["box"],
                        "originalVerdict": {
                            "semantic": row["semantic"],
                            "score": row["semanticScore"],
                        },
                        "context": evidence,
                    }
                )
                row["semantic"] = "Lyrics"
                row["semanticScore"] = evidence["combinedVerdict"]["score"]
                row["proposedLyric"] = True
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "rows.jsonl").write_text(
        "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in pages)
    )
    (args.out / "report.json").write_text(
        json.dumps(
            {
                "scope": "Source-free development context rule using frozen original anchored lyric peers; original OCR text preserved. Changes are proposals, never automatic attachments. No independent qualification.",
                "minimumPeers": args.minimum_peers,
                "inputSha256": binding,
                "changes": changes,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "changedRows": len(changes),
                "changes": [(c["pageId"].split(":")[0], c["text"]) for c in changes],
            }
        )
    )


if __name__ == "__main__":
    main()
