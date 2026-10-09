"""Score only reference-covered OCR rows; unlabelled page areas stay unscored."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def reference_rectangle(box):
    """Legacy quadrilateral annotations use their enclosing axis-aligned rectangle."""
    if len(box) != 4:
        raise ValueError("Reference box must have four coordinates or corners")
    if all(isinstance(x, (int, float)) for x in box):
        return box
    if all(isinstance(p, (list, tuple)) and len(p) == 2 for p in box):
        return [
            min(p[0] for p in box),
            min(p[1] for p in box),
            max(p[0] for p in box),
            max(p[1] for p in box),
        ]
    raise ValueError("Invalid reference geometry")


def reference_role(box, references):
    left, top, right, bottom = box
    area = max(0, right - left) * max(0, bottom - top)
    if not area:
        return None
    roles = set()
    for reference in references:
        a, b, c, d = reference["preparedBox"]
        overlap = max(0, min(right, c) - max(left, a)) * max(
            0, min(bottom, d) - max(top, b)
        )
        if overlap / area >= 0.8:
            roles.add(reference["ground_truth_role"])
    return next(iter(roles)) if len(roles) == 1 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--references", type=Path, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    references = json.loads(args.references.read_text())
    transforms = json.loads((args.replay / "preparation.json").read_text())[
        "transforms"
    ]
    pages = json.loads((args.replay / "pages.json").read_text())
    transform_byid = {t["preparedId"]: t for t in transforms}
    totals = Counter()
    records = []
    binding = {}
    for page in pages:
        transform = transform_byid[page["id"]]
        sx = transform["preparedSize"][0] / transform["originalSize"][0]
        sy = transform["preparedSize"][1] / transform["originalSize"][1]
        refs = [
            {
                **r,
                "preparedBox": [
                    reference_rectangle(r["box"])[0] * sx,
                    reference_rectangle(r["box"])[1] * sy,
                    reference_rectangle(r["box"])[2] * sx,
                    reference_rectangle(r["box"])[3] * sy,
                ],
            }
            for r in references
            if r["score"] == page["score"]
        ]
        filename = page["score"] + "_" + page["id"].split(":")[-1] + ".json"
        original_path = args.replay / "filtered" / filename
        context_path = args.context / "filtered" / filename
        for path in [original_path, context_path]:
            binding[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        original = json.loads(original_path.read_text())["ocrRows"]
        context = {r["id"]: r for r in json.loads(context_path.read_text())["ocrRows"]}
        for row in original:
            role = reference_role(row["box"], refs)
            after = context[row["id"]]
            if role:
                totals[role + ":matchedSelectedOcrRows"] += 1
                totals[role + ":baselineRetained"] += int(row["proposedLyric"])
                totals[role + ":contextRetained"] += int(after["proposedLyric"])
            if role or row["proposedLyric"] != after["proposedLyric"]:
                records.append(
                    {
                        "pageId": page["id"],
                        "candidateId": row["id"],
                        "text": row["text"],
                        "groundTruthRole": role,
                        "baselineRetained": row["proposedLyric"],
                        "contextRetained": after["proposedLyric"],
                        "unlabelled": role is None,
                    }
                )
    for path in [
        Path(__file__),
        args.references,
        args.replay / "preparation.json",
        args.replay / "pages.json",
        args.context / "report.json",
    ]:
        binding[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "scope": "Partial positive annotations on previously inspected semantic controls. Legacy quadrilaterals use enclosing axis-aligned rectangles. Conditional retention only for selected OCR rows wholly covered (>=80%) by one reference role. Unlabelled rows are unscored, not negative. No whole-page recall, exact text, ownership or independent release qualification.",
                "counts": dict(totals),
                "rows": records,
                "inputSha256": binding,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(json.dumps(dict(totals)))


if __name__ == "__main__":
    main()
