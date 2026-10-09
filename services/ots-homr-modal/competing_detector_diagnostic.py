"""Unshipped non-lyric-region conflict flag; scores are not calibrated probabilities."""

NON_LYRIC_CLASSES = {
    "Dynamic",
    "Fingering",
    "MeasureNumber",
    "Tempo",
    "Expression",
    "DirectionText",
}


def competing_detector_context(row, raw_detections):
    if not row.get("proposedLyric"):
        return None
    left, top, right, bottom = row["box"]
    area = (right - left) * (bottom - top)
    if area <= 0:
        return None
    evidence = {}
    for detector in ["lyrics", "non-lyric-text"]:
        hits = []
        for box in raw_detections.get(detector, []):
            if box["label"] not in NON_LYRIC_CLASSES or box["confidence"] < 0.7:
                continue
            overlap = max(0, min(right, box["right"]) - max(left, box["left"])) * max(
                0, min(bottom, box["bottom"]) - max(top, box["top"])
            )
            coverage = overlap / area
            if coverage >= 0.8:
                hits.append(
                    {
                        "label": box["label"],
                        "confidence": box["confidence"],
                        "coverage": coverage,
                        "box": [box["left"], box["top"], box["right"], box["bottom"]],
                    }
                )
        if not hits:
            return None
        evidence[detector] = max(hits, key=lambda h: h["confidence"])
    return {"reason": "both-detectors-cover-non-lyric-region", "detectors": evidence}
