"""Unshipped context pilot; preserve frozen predictions and original OCR text."""

import re


def rect(row):
    box = row["box"]
    if isinstance(box[0], (int, float)):
        return box
    return [
        min(p[0] for p in box),
        min(p[1] for p in box),
        max(p[0] for p in box),
        max(p[1] for p in box),
    ]


def direction_context(row, full_rows, gate):
    """Suggest review withholding for a tightly aligned short fragment; never attach."""
    if not row.get("proposedLyric") or not re.fullmatch(
        r"[^\W\d_]{1,3}", row["text"], re.UNICODE
    ):
        return None
    left, top, right, bottom = rect(row)
    height = bottom - top
    if height <= 0:
        return None
    for other in full_rows:
        if other["text"] == row["text"] and rect(other) == rect(row):
            continue
        a, b, c, d = rect(other)
        other_height = d - b
        if other_height <= 0 or not 0.5 <= other_height / height <= 2:
            continue
        overlap = max(0, min(bottom, d) - max(top, b))
        gap = max(0, a - right, left - c)
        if overlap / min(height, other_height) < 0.7 or gap > 0.35 * height:
            continue
        neighbour = gate.classify(other["text"])
        if neighbour["prediction"] != "DirectionText" or neighbour["score"] > 0.1:
            continue
        combined = " ".join(
            [row["text"], other["text"]] if left <= a else [other["text"], row["text"]]
        )
        verdict = gate.classify(combined)
        if verdict["prediction"] == "DirectionText" and verdict["score"] <= 0.1:
            return {
                "reason": "adjacent-direction-context",
                "combinedText": combined,
                "neighbourText": other["text"],
                "neighbourBox": rect(other),
                "verdict": verdict,
            }
    return None
