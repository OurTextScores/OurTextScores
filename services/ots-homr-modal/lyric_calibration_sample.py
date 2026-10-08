"""Select the unmatched boxes a person should judge, and fit isotonic precision bins.

Matched = knownCoverage >= MATCH_COVERAGE against OCR-confirmed lyric positives. Unmatched boxes on
vocal pages are unknown until judged; boxes on instrumental pages are verified negatives and are
reported separately, never mixed into the vocal-page precision.
"""

import hashlib

EDGES = [0.5, 0.6, 0.7, 0.8, 0.9]
MATCH_COVERAGE = 0.5


def band(raw):
    chosen = None
    for index, edge in enumerate(EDGES):
        if raw >= edge:
            chosen = index
    return chosen


def box_id(page_id, box):
    return hashlib.sha256(f"{page_id}:{box}".encode()).hexdigest()[:20]


def candidates(pages):
    """Flatten detections to boxes at/above the lowest edge with a stable id and a status."""
    for page in pages:
        for box in page["boxes"]:
            index = band(box["rawConfidence"])
            if index is None:
                continue
            if box["verifiedNegative"]:
                status = "negative"
            elif box["knownCoverage"] >= MATCH_COVERAGE:
                status = "matched"
            else:
                status = "unmatched"
            yield {
                "id": box_id(page["id"], box["box"]),
                "page": page["id"],
                "score": page["score"],
                "corpus": page["corpus"],
                "box": box["box"],
                "rawConfidence": box["rawConfidence"],
                "band": index,
                "status": status,
            }


def sample_unmatched(rows, per_band=30, per_score=3):
    """Stable, score-spread sample of unmatched vocal-page boxes, per confidence band."""
    chosen = []
    for index in range(len(EDGES)):
        pool = sorted(
            (r for r in rows if r["status"] == "unmatched" and r["band"] == index),
            key=lambda r: hashlib.sha256(r["id"].encode()).hexdigest(),
        )
        taken, counts = [], {}
        for row in pool:
            if counts.get(row["score"], 0) >= per_score:
                continue
            counts[row["score"]] = counts.get(row["score"], 0) + 1
            taken.append(row)
            if len(taken) == per_band:
                break
        chosen.extend(taken)
    return chosen


def pav(values, weights):
    """Pool-adjacent-violators: the non-decreasing fit to `values` under `weights`."""
    blocks = []
    for value, weight in zip(values, weights):
        blocks.append([value * weight, weight, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            total, weight_, count = blocks.pop()
            blocks[-1][0] += total
            blocks[-1][1] += weight_
            blocks[-1][2] += count
    fitted = []
    for total, weight, count in blocks:
        fitted.extend([total / weight] * count)
    return fitted


def fit(rows, judgements):
    """Per-band vocal-page precision: matched count + judged-lyric rate x unmatched count.

    `judgements` maps box id -> 'lyric' | 'not-lyric' | 'unsure'. Unsure is excluded from the
    rate. A band with matches/unmatched but no usable judgement raises: it would be a guess.
    """
    bands = []
    for index in range(len(EDGES)):
        matched = sum(1 for r in rows if r["band"] == index and r["status"] == "matched")
        unmatched = sum(1 for r in rows if r["band"] == index and r["status"] == "unmatched")
        judged = [
            judgements[r["id"]]
            for r in rows
            if r["band"] == index and r["status"] == "unmatched" and r["id"] in judgements
        ]
        usable = [j for j in judged if j in ("lyric", "not-lyric")]
        if unmatched and not usable:
            raise ValueError(f"band {index} has unmatched boxes but no usable judgement")
        rate = (sum(j == "lyric" for j in usable) / len(usable)) if usable else 0.0
        total = matched + unmatched
        bands.append(
            {
                "lowerEdge": EDGES[index],
                "matched": matched,
                "unmatched": unmatched,
                "judged": len(judged),
                "usable": len(usable),
                "unsure": len(judged) - len(usable),
                "judgedLyricRate": rate,
                "precision": ((matched + rate * unmatched) / total) if total else None,
                "boxes": total,
            }
        )
    populated = [b for b in bands if b["precision"] is not None]
    fitted = pav([b["precision"] for b in populated], [b["boxes"] for b in populated])
    for b, value in zip(populated, fitted):
        b["calibrated"] = round(value, 4)
    return bands
