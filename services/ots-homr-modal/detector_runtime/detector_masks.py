"""
Turn detection boxes into per-pixel label masks, in the shape homr's own segmentation
model already expects.

27.68 found the detector half of 27.45 was never built and readied its data as a box list.
A box list is not yet something a model can train on; homr already has a proven answer for
"find small objects on a large, mostly-blank sheet-music page" - `homr/segmentation` runs a
U-Net over 320x320 patches tiled across the full-resolution page with 50% overlap, and
recovers noteheads and staff lines from the predicted per-pixel class map by connected
components (`inference_segnet.extract`). A lyric syllable at a measured median 34x16 pixels
(27.44) is exactly the kind of target that pattern was built for, and one page downsampled
to a single fixed size would lose it entirely.

**This module produces the same shape of target the existing segmentation model trains
against - a per-pixel class mask - not a new architecture.** The model itself is a decision
left open in 27.68; this is the data step ahead of it, and it is testable on CPU.

**Class 0 is always background.** Classes 1..N follow `CLASS_ORDER`, a fixed list rather
than derived from whatever appears in one manifest - a mask's channel meaning has to be
stable across every image it is compared against or stitched from, and a set's iteration
order is not a contract.

**Overlap is resolved by drawing in a fixed priority order, later drawn over earlier.**
Two boxes overlapping is rare in engraved music - text does not print on top of itself -
but not impossible at a box's edge from measurement slack, and silently ignoring the
question would leave the tie-break to dictionary order, which is not documented and not
stable.
"""

# flake8: noqa: T201

import argparse
import collections
import json
from pathlib import Path

import cv2
import numpy as np

from .detector_data import Box, collect

#: Fixed index for every class this detector can predict, background always 0. Order beyond
#: that is the priority used when boxes overlap - later in the list wins, chosen roughly by
#: how large and unambiguous a class's boxes are, so a specific small label drawn over a
#: sprawling class name is a more defensible default than the reverse.
#:
#: Dynamic added 27.94: excluded from the OCR *recognizer* (music glyph, not text - 27.45),
#: but that is not an argument against detecting its box, and at 5,013 boxes it is the most
#: common non-Lyrics class in the corpus - placed early, like Fingering, since it is small
#: and specific rather than a sprawling text class.
CLASS_ORDER = (
    "Dynamic", "Fingering", "Expression", "Tempo",
    "MeasureNumber", "StaffText", "Lyrics",
)

#: 27.92: SystemText stayed at exactly 0% whole-page precision/recall even after 27.90
#: manufactured 156 real, correctly-labelled SystemText boxes for it - unlike Fingering,
#: which the same technique moved off zero. Confirmed the injected masks genuinely carried
#: SystemText pixels, so this is not a data or pipeline bug; the working hypothesis is that
#: SystemText is visually too close to StaffText (both small text near the top of a
#: system) for this detector to separate given the source corpus's SystemText scarcity (3
#: real boxes total, 27.68). Folding it into StaffText rather than continuing to spend
#: training attention on a class this detector cannot resolve.
CLASS_ALIASES = {"SystemText": "StaffText"}

BACKGROUND = 0
CLASS_INDEX = {name: index + 1 for index, name in enumerate(CLASS_ORDER)}


def canonical_label(label: str) -> str:
    return CLASS_ALIASES.get(label, label)


def rasterize(width: int, height: int, boxes: list[Box]) -> np.ndarray:
    """A single-channel mask, one pixel per source pixel, background 0 elsewhere."""
    mask = np.full((height, width), BACKGROUND, dtype=np.uint8)
    for box in boxes:
        label = canonical_label(box.label)
        if label not in CLASS_INDEX:
            continue
        left = max(0, min(width, box.left))
        right = max(0, min(width, box.right))
        top = max(0, min(height, box.top))
        bottom = max(0, min(height, box.bottom))
        if right > left and bottom > top:
            mask[top:bottom, left:right] = CLASS_INDEX[label]
    return mask


def by_image(boxes: list[Box]) -> dict[str, list[Box]]:
    grouped: dict[str, list[Box]] = collections.defaultdict(list)
    for box in boxes:
        grouped[box.image].append(box)
    return grouped


def write_masks(boxes_dir: Path, out_dir: Path) -> list[tuple[str, str]]:
    """Rasterize every annotated page and write its mask; returns (image, mask) pairs.

    Masks are PNGs, not raw arrays: a page-sized mask is background almost everywhere, and
    PNG's run-length-friendly compression makes that cheap - a few kilobytes rather than a
    few megabytes per page.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    boxes = collect(boxes_dir)
    pairs = []
    for image_path, image_boxes in by_image(boxes).items():
        image = cv2.imread(image_path)
        if image is None:
            continue
        mask = rasterize(image.shape[1], image.shape[0], image_boxes)
        mask_path = out_dir / (Path(image_path).stem + ".mask.png")
        cv2.imwrite(str(mask_path), mask)
        pairs.append((image_path, str(mask_path)))
    return pairs


def write_index(pairs: list[tuple[str, str]], path: Path) -> None:
    path.write_text(
        "\n".join(f"{image},{mask}" for image, mask in pairs) + "\n", encoding="utf-8"
    )


def describe(pairs: list[tuple[str, str]]) -> str:
    if not pairs:
        return "no masks written"
    coverage = []
    for _, mask_path in pairs[:200]:
        mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if mask is not None:
            coverage.append(float((mask != BACKGROUND).mean()))
    lines = [f"{len(pairs):,} page masks written"]
    if coverage:
        lines.append(
            f"  text pixels: {np.mean(coverage):.2%} of a page, sampled over {len(coverage)}"
        )
        lines.append("  (a 320x320 patch tiled at random over a page this sparse needs")
        lines.append("  positive sampling, or nearly every patch trains on background alone)")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--boxes", type=Path, required=True, help="A musescore_boxes out dir.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    pairs = write_masks(args.boxes, args.out)
    if not pairs:
        raise SystemExit(f"No masks produced from {args.boxes}")
    write_index(pairs, args.out / "index.txt")
    print(describe(pairs))
    print(f"\nclass order (index: name): " + ", ".join(f"{i + 1}:{n}" for i, n in enumerate(CLASS_ORDER)))


if __name__ == "__main__":
    main()
