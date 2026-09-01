"""
Sample 320x320 training patches biased toward the boxes, not tiled uniformly across the page.

27.69 measured text coverage at 0.38% of a page. homr's own segmentation training
(`training/segmentation/dense_dataset_definitions.py`) tiles a plain non-overlapping grid of
320x320 patches across the whole page with no bias toward content, which is right for its
own targets - noteheads and staff lines are dense enough that most tiles contain some. Text
is not: a typical page here holds around 13 boxes (27.68 - 37,356 boxes over 2,847 images),
and a 4500x3200 page tiles into on the order of 140 non-overlapping 320x320 windows, so an
unbiased grid would put text in a handful of tiles and nothing in the rest. Copying homr's
sampler here would train a detector almost entirely on the answer "nothing here" - which
28.62's global-focal mistake already showed happens by accident when a correction is applied
somewhere it was not measured to be needed; this is the same trap approached from the data
side, avoided by measuring first rather than reusing a pattern built for different data.

**Sampling, not tiling.** Each drawn patch is centred either on a randomly chosen box (with
jitter, so a box is not always dead-centre) or on a uniformly random page location, at a
fixed ratio - the positive samples give the loss something to learn from every step, the
negative samples keep the model from predicting text everywhere out of habit.

Edge padding follows the convention already set for this corpus: white for the image (paper,
not ink - 27.51's recogniser found the alternative teaches the model that every crop ends in
a black bar), background class for the mask.
"""

import random
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset, Sampler

from .detector_masks import CLASS_INDEX, CLASS_ORDER

#: Matches homr's own segmentation patch size (training/segmentation/train.py), so a
#: detector trained on this data could share inference-time tiling logic with the existing
#: segmentation model if that turns out to be worth doing later.
PATCH_SIZE = 320

#: Share of drawn patches centred on a box rather than a random location.
POSITIVE_RATIO = 0.7

#: Fraction of the patch size a positive sample's centre may drift from the box centre, so
#: the box is not always dead-centre - a detector trained on perfectly centred boxes only
#: would not learn to find one near a patch edge.
JITTER = 0.3

PAD_IMAGE_VALUE = 255
PAD_MASK_VALUE = 0


@dataclass(frozen=True)
class Sample:
    image: str
    mask: str


def read_index(path: Path) -> list[Sample]:
    """`image,mask` per line - split from the *right*.

    Image paths in this corpus contain commas: OSSQ files them by composer, so a page
    lives under `Haydn,_Joseph/String_Quartet_in_F_major,_Hob.III73,_Op.74_No.2/`. A
    plain `split(",")` returns five fields for that line and raises, which is at least
    loud - but splitting from the left and taking the first two would be worse, quietly
    pairing a truncated path with a directory name. The mask side is written by
    `scan_text_masks.py` as `<score>_<page>.mask.png`, which cannot contain a comma, so
    the last one is always the separator.
    """
    samples = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        image, mask = line.rsplit(",", 1)
        samples.append(Sample(image, mask))
    return samples


def box_centres_by_class(mask: np.ndarray) -> dict[str, list[tuple[int, int]]]:
    """Centres grouped by class, not pooled - 27.87 found whole-page precision collapses
    for every class except Lyrics and MeasureNumber, and the leading suspect is this
    sampler: a page's positive centre used to be drawn uniformly from *all* connected
    foreground regions regardless of class, so a page with dozens of Lyrics boxes and one
    Tempo mark almost never centred a patch on the Tempo mark - the model saw far fewer
    positive examples of rare classes than their corpus-wide box count suggests. Grouping
    by class lets the caller weight classes evenly instead of by how much of the page they
    cover.
    """
    found: dict[str, list[tuple[int, int]]] = {}
    for label in CLASS_ORDER:
        class_index = CLASS_INDEX[label]
        binary = (mask == class_index).astype(np.uint8)
        if not binary.any():
            continue
        count, _, _, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
        found[label] = [(int(round(cy)), int(round(cx))) for cx, cy in centroids[1:count]]
    return found


def classes_present(mask: np.ndarray) -> set[str]:
    return {label for label in CLASS_ORDER if (mask == CLASS_INDEX[label]).any()}


def class_page_counts(masks: Iterable[np.ndarray]) -> dict[str, int]:
    """How many distinct pages each class appears on at all, ignoring how many boxes of
    that class a page holds - a fingering mark spread across 400 pages and a tempo mark
    spread across 80 counts as 400 and 80 here, regardless of how many of each per page.

    This is the corpus-wide count `class_draw_weights` needs and `box_centres_by_class`
    cannot answer, because that function only ever sees one page at a time: it groups one
    mask's centres by class, with no visibility into how many *other* pages also contain
    that class. `DetectorPatches.__getitem__`'s per-page uniform choice among classes
    present on that page looks class-balanced locally, but a class present on many pages
    still accumulates far more total positive draws across an epoch than a class confined
    to a few pages, purely because it gets a turn on more pages - the mechanism this
    session's phase18 detector retrain result named as still unaddressed even after
    synthesizing Fingering onto 400 distinct pages instead of concentrating on 79.
    """
    counts: dict[str, int] = {}
    for mask in masks:
        for label in classes_present(mask):
            counts[label] = counts.get(label, 0) + 1
    return counts


def class_draw_weights(counts: dict[str, int]) -> dict[str, float]:
    """Per-class weight inversely proportional to how many distinct pages carry it, for
    `DetectorPatches`' per-page class choice - so a class spread across many pages does
    not out-compete a class confined to few pages just by having more chances to be
    picked. Weights are relative, not normalized to sum to 1 - `random.choices` only
    needs relative magnitudes. A class with a page count of 0 cannot appear here (nothing
    to divide by), which is fine: `classes_present`/`box_centres_by_class` never report a
    class that is not actually on the page being sampled.
    """
    return {label: 1.0 / count for label, count in counts.items()}


def patch_origin(
    center: tuple[int, int], shape: tuple[int, int], jitter: float, rng: random.Random
) -> tuple[int, int]:
    """Top-left corner of a patch around `center`, jittered and clamped to the page."""
    height, width = shape
    max_shift = int(PATCH_SIZE * jitter)
    y = center[0] - PATCH_SIZE // 2 + rng.randint(-max_shift, max_shift)
    x = center[1] - PATCH_SIZE // 2 + rng.randint(-max_shift, max_shift)
    return max(0, min(y, max(0, height - PATCH_SIZE))), max(0, min(x, max(0, width - PATCH_SIZE)))


def extract_patch(
    array: np.ndarray, origin: tuple[int, int], pad_value: int
) -> np.ndarray:
    """A `PATCH_SIZE` square from `array` at `origin`, padded past the page edge.

    Mirrors `SegmentationBaseDataset._get_patch`'s edge behaviour - pad rather than shrink,
    so every patch the model sees is the same shape regardless of where on the page it fell.
    """
    y, x = origin
    height, width = array.shape[:2]
    channels = array.shape[2:]
    patch = np.full((PATCH_SIZE, PATCH_SIZE, *channels), pad_value, dtype=array.dtype)
    y_end, x_end = min(y + PATCH_SIZE, height), min(x + PATCH_SIZE, width)
    patch[: y_end - y, : x_end - x] = array[y:y_end, x:x_end]
    return patch


class DetectorPatches(Dataset):
    def __init__(
        self,
        samples: list[Sample],
        patches_per_image: int = 8,
        positive_ratio: float = POSITIVE_RATIO,
        seed: int = 0,
        class_weights: dict[str, float] | None = None,
    ) -> None:
        self.samples = samples
        self.patches_per_image = patches_per_image
        self.positive_ratio = positive_ratio
        self.rng = random.Random(seed)
        # None (the default) keeps the original per-page-uniform behaviour exactly -
        # this is additive, not a replacement, since the uniform choice is still the
        # right default for a corpus without the "one class spread across far more
        # distinct pages than another" problem `class_draw_weights` exists to correct.
        self.class_weights = class_weights
        # Every image is decoded up to `patches_per_image` times per epoch - once per
        # patch drawn from it. A one-slot cache turns that into one decode per image, as
        # long as those draws arrive consecutively (see ImageBlockSampler), which a plain
        # `shuffle=True` DataLoader does not guarantee: it shuffles every patch index
        # independently, so a given image's 8 patches land scattered across the epoch and
        # this cache would almost never hit. Measured: full-corpus epoch 1 was still not
        # done after 12 minutes with 0% average GPU utilisation, workers pegged decoding -
        # not a hang, just 8x more image decoding than the data needs.
        self._cache_index: int | None = None
        self._cache_image: np.ndarray | None = None
        self._cache_mask: np.ndarray | None = None
        # Caching the decode alone was not enough. `box_centres_by_class` is a pure
        # function of the mask, but it ran on every single draw: seven full-page
        # `mask == index` comparisons plus a `connectedComponentsWithStats` per class
        # actually present. That is far more work than the `imread` the cache above was
        # added to avoid, and it dwarfed it - measured on the synthetic baseline, eight
        # workers stayed pegged for nine minutes without completing a single batch while
        # the GPU sat at 0%. Cached alongside the mask it is computed once per image, as
        # the decode already was.
        self._cache_centres: dict[str, list[tuple[int, int]]] | None = None

    def __len__(self) -> int:
        return len(self.samples) * self.patches_per_image

    def __getitem__(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        image_index = index // self.patches_per_image
        sample = self.samples[image_index]
        if self._cache_index == image_index:
            image, mask = self._cache_image, self._cache_mask
            centres_by_class = self._cache_centres
        else:
            image = cv2.imread(sample.image)
            mask = cv2.imread(sample.mask, cv2.IMREAD_GRAYSCALE)
            if image is None or mask is None:
                raise FileNotFoundError(f"cannot read {sample.image} or {sample.mask}")
            centres_by_class = box_centres_by_class(mask)
            self._cache_index, self._cache_image, self._cache_mask = image_index, image, mask
            self._cache_centres = centres_by_class

        positive = centres_by_class and self.rng.random() < self.positive_ratio
        if positive:
            # Pick a class among those present on this page, then a centre of that class
            # - not a centre uniformly among all boxes, which would draw a class in
            # proportion to how much of the page it covers rather than giving every
            # class a controlled share of positive training examples. Uniform among
            # present classes by default; `class_weights` (typically
            # `class_draw_weights`'s inverse-page-count weighting) skews that per-page
            # choice so a class present on many more pages does not also win far more
            # positive draws corpus-wide purely by having more pages to be chosen on.
            present = sorted(centres_by_class)
            if self.class_weights is not None:
                weights = [self.class_weights.get(label, 1.0) for label in present]
                label = self.rng.choices(present, weights=weights, k=1)[0]
            else:
                label = self.rng.choice(present)
            center = self.rng.choice(centres_by_class[label])
        else:
            center = (
                self.rng.randint(0, mask.shape[0] - 1), self.rng.randint(0, mask.shape[1] - 1)
            )
        origin = patch_origin(center, mask.shape[:2], JITTER, self.rng)

        return (
            extract_patch(image, origin, PAD_IMAGE_VALUE),
            extract_patch(mask, origin, PAD_MASK_VALUE),
        )


class PreExtractedPatches(Dataset):
    """Patches already drawn to disk by `extract_patch_bank.py` - one file pair per
    patch, read as-is.

    There is deliberately no sampling here. Every decision `DetectorPatches` makes per
    draw (positive or negative, which class, how much jitter) was made once when the
    bank was written, so a run over a bank cannot silently draw something different
    from the run it is being compared against. It also means no block sampler: the
    files are patch-sized, so a plain shuffled DataLoader is cheap and gives batches
    that mix pages instead of being drawn from one or two.
    """

    def __init__(self, samples: list[Sample]) -> None:
        self.samples = samples

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        sample = self.samples[index]
        image = cv2.imread(sample.image)
        mask = cv2.imread(sample.mask, cv2.IMREAD_GRAYSCALE)
        if image is None or mask is None:
            raise FileNotFoundError(f"cannot read {sample.image} or {sample.mask}")
        return image, mask


class ImageBlockSampler(Sampler[int]):
    """Yields every image's `patches_per_image` indices consecutively, image order
    shuffled per epoch - what makes `DetectorPatches`' one-slot decode cache actually hit.
    A DataLoader worker fetches one batch's indices in one call, in order, so as long as a
    batch does not straddle two images in a way that interleaves them (it does not here:
    the sampler emits whole image-blocks back to back), the cache sees the same image
    across consecutive `__getitem__` calls instead of never twice in a row.
    """

    def __init__(self, num_images: int, patches_per_image: int, seed: int = 0) -> None:
        self.num_images = num_images
        self.patches_per_image = patches_per_image
        self.seed = seed
        self.epoch = 0

    def __iter__(self):
        generator = torch.Generator()
        generator.manual_seed(self.seed + self.epoch)
        self.epoch += 1
        for image_index in torch.randperm(self.num_images, generator=generator).tolist():
            base = image_index * self.patches_per_image
            yield from range(base, base + self.patches_per_image)

    def __len__(self) -> int:
        return self.num_images * self.patches_per_image
