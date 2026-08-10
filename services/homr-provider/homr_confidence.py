"""Capture per-symbol confidence and page geometry from HOMR, without forking it.

HOMR's decoder already computes what a review UI needs and then discards it. At
every decode step it produces a full logit vector for each of six independent
heads and keeps only the `argmax`:

    rhythm_sample = np.array([[rhythmsp[:, -1, :].argmax()]])

A softmax over those same logits is the confidence, and the top-k are the
alternatives worth offering a user. Nothing here changes what HOMR predicts —
the argmax it would have taken is still the value it reports.

Three patch points, all restored on exit:

* `ScoreDecoder.io_binding.get_outputs` — tees each step's distributions. Patched
  on the instance rather than wrapping the object, because `run_with_iobinding`
  is handed the same binding and needs the real one.
* `Staff2Score.predict` — the staff boundary. It returns the decoder's output
  before any downstream filtering, so distributions pair with symbols 1:1 here
  and nowhere later.
* `staff_parsing.parse_staff_image` — supplies the staff index and the page
  coordinates of its region.

Confidence rides on the symbol objects themselves, so downstream filtering (for
instance `predict_best` dropping `position == "lower"`) carries it along and
cannot desynchronise it from the symbols that survive.
"""

from __future__ import annotations

import math
from typing import Any

# Output order is fixed by `ScoreDecoder.output_names`.
HEAD_NAMES = ("rhythm", "pitch", "lift", "position", "articulation", "slur")

# How many alternatives to carry per head. Four is what the review UI shows,
# including the chosen value.
TOP_K = 4

# Attribute stamped onto each EncodedSymbol.
CONFIDENCE_ATTR = "_ots_heads"

# The decoder and its io_binding outlive any one page: the engine keeps a warm
# child, and `staff_parsing_tromr` caches a single `Staff2Score` in a module
# global. So the binding is patched once, permanently, and the patch writes to
# whichever capture is currently active rather than closing over one of them.
# Binding it to a particular capture meant the warm-up claimed the patch and
# every later page recorded into that discarded object.
_ACTIVE: list[Any] = [None]


def _softmax(logits: list[float]) -> list[float]:
    """Numerically stable softmax over a single step's logits."""
    if not logits:
        return []
    largest = max(logits)
    exponentials = [math.exp(value - largest) for value in logits]
    total = sum(exponentials)
    if total <= 0:
        return [0.0 for _ in logits]
    return [value / total for value in exponentials]


def _top_k(probabilities: list[float], vocabulary: dict[int, str], k: int) -> list[dict[str, Any]]:
    ranked = sorted(range(len(probabilities)), key=lambda i: probabilities[i], reverse=True)
    out: list[dict[str, Any]] = []
    for index in ranked[:k]:
        token = vocabulary.get(index)
        if token is None:
            continue
        out.append({"value": token, "confidence": round(float(probabilities[index]), 6)})
    return out


class PageCapture:
    """Accumulates per-staff geometry and per-symbol confidence for one page."""

    def __init__(self) -> None:
        self.staves: list[dict[str, Any]] = []
        self._steps: list[list[Any]] = []
        self._decoder: Any = None

    # -- decoder side -----------------------------------------------------

    def reset_steps(self) -> None:
        self._steps = []

    def record_step(self, outputs: Any) -> None:
        # outputs[0:6] are the head logits, [6] attention, [7:] the kv cache.
        if len(outputs) < 7:
            return
        self._steps.append([outputs[i].numpy()[:, -1, :].copy() for i in range(6)])

    def attach_decoder(self, decoder: Any) -> None:
        self._decoder = decoder
        binding = decoder.io_binding
        if getattr(binding, "_ots_recording", False):
            return
        original = binding.get_outputs

        def recording_get_outputs() -> Any:
            outputs = original()
            active = _ACTIVE[0]
            if active is not None:
                active.record_step(outputs)
            return outputs

        binding.get_outputs = recording_get_outputs
        binding._ots_recording = True

    def _vocabularies(self) -> list[dict[int, str]]:
        decoder = self._decoder
        return [
            decoder.inv_rhythm_vocab,
            decoder.inv_pitch_vocab,
            decoder.inv_lift_vocab,
            decoder.inv_position_vocab,
            decoder.inv_articulation_vocab,
            decoder.inv_slur_vocab,
        ]

    def stamp(self, symbols: list[Any]) -> None:
        """Attach each step's distributions to the symbol it produced.

        The decode loop breaks on EOS *before* appending, so there is one more
        recorded step than there are symbols; the extra one is discarded by
        zipping against the shorter list.
        """
        if self._decoder is None:
            return
        vocabularies = self._vocabularies()
        for symbol, step in zip(symbols, self._steps):
            heads: dict[str, Any] = {}
            for position, name in enumerate(HEAD_NAMES):
                logits = step[position].reshape(-1).tolist()
                probabilities = _softmax(logits)
                ranked = _top_k(probabilities, vocabularies[position], TOP_K)
                if not ranked:
                    continue
                heads[name] = {
                    "chosen": ranked[0]["value"],
                    "confidence": ranked[0]["confidence"],
                    "alternatives": ranked[1:],
                }
            setattr(symbol, CONFIDENCE_ATTR, heads)

    # -- page side --------------------------------------------------------

    def add_staff(
        self, index: int, region: Any, symbols: list[Any], bar_lines: Any = None
    ) -> None:
        entries: list[dict[str, Any]] = []
        for ordinal, symbol in enumerate(symbols):
            heads = getattr(symbol, CONFIDENCE_ATTR, None)
            if not heads:
                continue
            coordinates = getattr(symbol, "coordinates", None)
            entries.append(
                {
                    "index": ordinal,
                    "rhythm": symbol.rhythm,
                    "heads": heads,
                    # Attention-derived and unreliable (HOMR's own caveat); a
                    # highlight hint only, never the crop boundary.
                    "attention": _attention_point(coordinates),
                }
            )
        self.staves.append(
            {
                "index": int(index),
                "region": [int(value) for value in region] if region is not None else None,
                # Detected bar lines in page coordinates. These are what make a
                # measure-level crop possible: unlike the attention point they
                # come from segmentation, so they can be trusted as boundaries.
                "barLines": sorted(bar_lines) if bar_lines else [],
                "symbols": entries,
            }
        )

    def as_dict(self) -> dict[str, Any]:
        return {"staves": self.staves}


def _attention_point(coordinates: Any) -> list[float] | None:
    if coordinates is None:
        return None
    try:
        x, y = float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError, IndexError):
        return None
    if math.isnan(x) or math.isnan(y):
        return None
    return [round(x, 2), round(y, 2)]


class capture_page:  # noqa: N801 - used as a context manager
    """Install the patches for one page, and remove them afterwards."""

    def __init__(self) -> None:
        self.page = PageCapture()
        self._undo: list[Any] = []

    def __enter__(self) -> PageCapture:
        from homr import staff_parsing
        from homr.transformer import staff2score

        page = self.page
        _ACTIVE[0] = page

        original_predict = staff2score.Staff2Score.predict

        def predict(inner_self: Any, image: Any) -> Any:
            page.attach_decoder(inner_self.decoder)
            page.reset_steps()
            symbols = original_predict(inner_self, image)
            page.stamp(symbols)
            return symbols

        staff2score.Staff2Score.predict = predict
        self._undo.append(lambda: setattr(staff2score.Staff2Score, "predict", original_predict))

        original_parse = staff_parsing.parse_staff_image

        def parse_staff_image(
            debug: Any, index: int, staff: Any, image: Any, regions: Any, config: Any
        ) -> Any:
            symbols = original_parse(debug, index, staff, image, regions, config)
            region = None
            try:
                region = staff_parsing._calculate_region(staff, regions)
            except Exception:  # pragma: no cover - geometry is best effort
                region = None
            bar_lines: list[int] = []
            try:
                bar_lines = [int(line.center[0]) for line in staff.get_bar_lines()]
            except Exception:  # pragma: no cover - geometry is best effort
                bar_lines = []
            page.add_staff(index, region, symbols, bar_lines)
            return symbols

        staff_parsing.parse_staff_image = parse_staff_image
        self._undo.append(
            lambda: setattr(staff_parsing, "parse_staff_image", original_parse)
        )
        return page

    def __exit__(self, *_: Any) -> None:
        _ACTIVE[0] = None
        for undo in reversed(self._undo):
            try:
                undo()
            except Exception:  # pragma: no cover - restoration is best effort
                pass
        self._undo = []
