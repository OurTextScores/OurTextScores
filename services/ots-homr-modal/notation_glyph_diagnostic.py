"""Unshipped image-context flag for single OCR glyphs centred inside five staff lines."""

import cv2
import numpy as np


def staff_line_mask(image):
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    ink = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 15
    )
    return cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, np.ones((1, max(80, image.shape[1] // 25)), dtype=np.uint8)
    )


def notation_glyph_context(row, lines):
    text = row["text"].strip()
    if len(text) != 1 or not text.isalnum() or not row.get("proposedLyric"):
        return None
    left, top, right, bottom = row["box"]
    height, width = lines.shape
    margin_x = max(100, 4 * (right - left))
    margin_y = max(120, 3 * (bottom - top))
    x0, x1 = max(0, left - margin_x), min(width, right + margin_x)
    y0, y1 = max(0, top - margin_y), min(height, bottom + margin_y)
    if x1 <= x0 or y1 <= y0:
        return None
    ys = np.flatnonzero((lines[y0:y1, x0:x1] > 0).mean(axis=1) >= 0.65) + y0
    groups = []
    for y in ys:
        if not groups or y > groups[-1][-1] + 1:
            groups.append([int(y)])
        else:
            groups[-1].append(int(y))
    centres = [float(np.mean(group)) for group in groups]
    centre_y = (top + bottom) / 2
    for start in range(len(centres) - 4):
        band = centres[start : start + 5]
        gaps = np.diff(band)
        spacing = float(np.median(gaps))
        if spacing < 2 or max(abs(gaps - spacing)) > 0.25 * spacing:
            continue
        if band[0] <= centre_y <= band[-1]:
            return {
                "reason": "single-glyph-inside-staff-band",
                "staffLineYs": band,
                "spacingPx": spacing,
                "glyphCentreY": centre_y,
            }
    return None
