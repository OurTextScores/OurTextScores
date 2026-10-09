"""Full-page OCR rows for lyric review, selected by the e2 lyric regions and gated semantically.

Reproduces the evaluated C1 pipeline: RapidOCR 3.9.2 (PP-OCRv6 small det/rec, mobile cls, pinned by
SHA-256) reads the whole page; a row is kept when at least `MIN_COVERAGE` of its box lies inside the
union of e2 `Lyrics` regions of area >= `MIN_REGION_AREA`; the frozen semantic gate then proposes
or withholds it as a lyric. Nothing here attaches text to MusicXML, and the OCR text is unreviewed.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Sequence

MODEL_SHA256 = {
    "Det": ("PP-OCRv6_det_small.onnx", "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "Rec": ("PP-OCRv6_rec_small.onnx", "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
    "Cls": ("ch_ppocr_mobile_v2.0_cls_mobile.onnx", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
}
RAPIDOCR_VERSION = "3.9.2"
MIN_REGION_AREA = 200
MIN_COVERAGE = 0.1
MAX_ROWS = 400


def _rect(points: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def union_coverage(box: Sequence[float], regions: Sequence[Sequence[float]]) -> float:
    """Exact fraction of `box` covered by the union of clipped `regions` (left, top, right, bottom)."""
    x0, y0, x1, y1 = box
    area = (x1 - x0) * (y1 - y0)
    if area <= 0:
        return 0.0
    clipped = []
    for left, top, right, bottom in regions:
        q = (max(x0, left), max(y0, top), min(x1, right), min(y1, bottom))
        if q[2] > q[0] and q[3] > q[1]:
            clipped.append(q)
    xs = sorted({x for q in clipped for x in (q[0], q[2])})
    covered = 0.0
    for left, right in zip(xs, xs[1:]):
        spans = sorted((q[1], q[3]) for q in clipped if q[0] <= left and q[2] >= right)
        top = bottom = None
        for a, b in spans:
            if top is None:
                top, bottom = a, b
            elif a <= bottom:
                bottom = max(bottom, b)
            else:
                covered += (right - left) * (bottom - top)
                top, bottom = a, b
        if top is not None:
            covered += (right - left) * (bottom - top)
    return covered / area


def select_rows(rows: Sequence[dict[str, Any]], lyric_boxes: Sequence[Sequence[int]]) -> list[dict[str, Any]]:
    """Keep OCR rows covered >= MIN_COVERAGE by large-enough lyric regions; add the coverage."""
    regions = [b for b in lyric_boxes if (b[2] - b[0]) * (b[3] - b[1]) >= MIN_REGION_AREA]
    selected = []
    for row in rows:
        coverage = union_coverage(_rect(row["box"]), regions)
        if coverage >= MIN_COVERAGE:
            selected.append({**row, "regionCoverage": coverage})
    return selected


class LyricTextPipeline:
    """RapidOCR + semantic gate. Construction verifies the pinned model files and library version."""

    def __init__(self, gate: Any, threads: int = 2) -> None:
        import importlib.metadata

        import rapidocr
        from rapidocr import RapidOCR

        if importlib.metadata.version("rapidocr") != RAPIDOCR_VERSION:
            raise RuntimeError("RapidOCR version differs from the pinned release")
        root = Path(rapidocr.__file__).parent / "models"
        params: dict[str, Any] = {
            "EngineConfig.onnxruntime.intra_op_num_threads": threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "EngineConfig.onnxruntime.use_cuda": False,
            "Global.log_level": "warning",
        }
        for role, (name, digest) in MODEL_SHA256.items():
            path = root / name
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"OCR model {name} differs from the pinned identity")
            params[role + ".model_path"] = str(path)
        self.engine = RapidOCR(params=params)
        self.gate = gate

    def read_page(self, page_bgr: Any) -> list[dict[str, Any]]:
        result = self.engine(page_bgr)
        if result.txts is None:
            return []
        return [
            {
                "box": [[round(float(x)), round(float(y))] for x, y in box],
                "text": str(text),
                "confidence": float(score),
            }
            for box, text, score in zip(result.boxes, result.txts, result.scores, strict=True)
        ]

    def lyric_rows(
        self, page_bgr: Any, lyric_boxes: Sequence[Sequence[int]], dynamic_rows: Sequence[dict[str, Any]] = ()
    ) -> dict[str, Any]:
        """OCR the page, keep e2-covered rows, classify each; bounded and order-stable."""
        all_rows = self.read_page(page_bgr)
        rows = select_rows(all_rows, lyric_boxes)
        rows.sort(key=lambda r: (_rect(r["box"])[1], _rect(r["box"])[0]))
        out = []
        for row in rows[:MAX_ROWS]:
            verdict = self.gate.classify(row["text"])
            left, top, right, bottom = _rect(row["box"])
            out.append(
                {
                    "box": [int(left), int(top), int(right), int(bottom)],
                    "text": row["text"],
                    "ocrConfidence": row["confidence"],
                    "regionCoverage": row["regionCoverage"],
                    "semantic": verdict["prediction"],
                    "semanticScore": verdict["score"],
                    "proposedLyric": verdict["proposedLyric"],
                }
            )
        return {
            "status": "ok",
            "rows": out,
            "rowsOmitted": max(0, len(rows) - MAX_ROWS),
            "directionRows": self._direction_rows(all_rows, out, dynamic_rows),
        }

    def _direction_rows(
        self,
        all_rows: Sequence[dict[str, Any]],
        lyric_rows: Sequence[dict[str, Any]],
        dynamic_rows: Sequence[dict[str, Any]] = (),
    ) -> dict[str, Any]:
        """Written directions and dynamics among the page's other OCR rows (review candidates only)."""
        from direction_text import MAX_DIRECTION_ROWS, direction_rows, merge_classifier_rows

        classified = []
        for row in all_rows:
            left, top, right, bottom = _rect(row["box"])
            verdict = self.gate.classify(row["text"])
            classified.append(
                {
                    "box": [int(left), int(top), int(right), int(bottom)],
                    "text": row["text"],
                    "ocrConfidence": row["confidence"],
                    "semantic": verdict["prediction"],
                    "semanticScore": verdict["score"],
                    "proposedLyric": verdict["proposedLyric"],
                }
            )
        offered = direction_rows(classified, [r["box"] for r in lyric_rows if r["proposedLyric"]])
        if not dynamic_rows:
            return {**offered, "rows": [{**r, "source": "ocr"} for r in offered["rows"]]}
        merged = merge_classifier_rows(offered["rows"], dynamic_rows, [r["box"] for r in classified])
        return {"rows": merged[:MAX_DIRECTION_ROWS], "rowsOmitted": offered["rowsOmitted"] + max(0, len(merged) - MAX_DIRECTION_ROWS)}
