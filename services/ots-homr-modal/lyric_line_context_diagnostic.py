"""Unshipped lyric-line context pilot. No references, length blacklist or attachment."""


def lyric_line_context(row, rows, gate, minimum_peers=2):
    if row.get("semantic") != "DirectionText" or not row.get("text", "").strip():
        return None
    left, top, right, bottom = row["box"]
    height = bottom - top
    if height <= 0:
        return None
    groups = {}
    for other in rows:
        if not other.get("proposedLyric") or not other.get("anchor"):
            continue
        a, b, c, d = other["box"]
        h = d - b
        overlap = max(0, min(bottom, d) - max(top, b))
        gap = max(0, a - right, left - c)
        if (
            h <= 0
            or not 0.5 <= h / height <= 2
            or overlap / min(height, h) < 0.6
            or gap > 4 * height
        ):
            continue
        groups.setdefault(other["anchor"]["staffIndex"], []).append(other)
    eligible = [
        (staff, peers) for staff, peers in groups.items() if len(peers) >= minimum_peers
    ]
    if len(eligible) != 1:
        return None
    staff, peers = eligible[0]
    combined = " ".join(
        r["text"] for r in sorted([row, *peers], key=lambda r: r["box"][0])
    )
    verdict = gate.classify(combined)
    if verdict["prediction"] != "Lyrics":
        return None
    return {
        "reason": "aligned-lyric-line-context",
        "staffIndex": staff,
        "peerIds": [p["id"] for p in peers],
        "combinedText": combined,
        "combinedVerdict": verdict,
    }
