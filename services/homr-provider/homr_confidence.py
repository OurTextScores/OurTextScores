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

# The decoder attention coordinates are expressed on HOMR's fixed staff canvas
# (`default_config.max_width`). They are never used as crop boundaries by
# themselves; they only associate an ordered decoded bar-line token with a
# nearby physical segmentation box.
MODEL_STAFF_WIDTH = 1280

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
        # `detect_staffs_in_image` computes trustworthy segmentation boxes for
        # bar lines, but HOMR only uses them while finding/grouping staves and
        # never adds them to `Staff.symbols`. Consequently
        # `Staff.get_bar_lines()` is empty even on an ordinary engraved page.
        # Keep the segmentation result at the page boundary and associate it
        # with physical staff regions below.
        self._detected_bar_lines: list[Any] = []
        self._bar_line_candidates: list[Any] = []

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

    def record_detected_bar_lines(
        self, bar_lines: list[Any], candidates: list[Any] | None = None
    ) -> None:
        self._detected_bar_lines = list(bar_lines)
        self._bar_line_candidates = list(candidates or bar_lines)

    @staticmethod
    def _lines_for_region(lines: list[Any], region: Any) -> list[Any]:
        if region is None or len(region) != 4:
            return []
        left, top, right, bottom = [float(value) for value in region]
        left, right = min(left, right), max(left, right)
        top, bottom = min(top, bottom), max(top, bottom)
        result: list[Any] = []
        for line in lines:
            try:
                center_x = float(line.center[0])
                polygon = getattr(line, "polygon", None)
                if polygon is not None and len(polygon) > 0:
                    ys = [float(point[1]) for point in polygon]
                    line_top, line_bottom = min(ys), max(ys)
                else:
                    center_y = float(line.center[1])
                    half_height = float(line.size[1]) / 2
                    line_top, line_bottom = center_y - half_height, center_y + half_height
            except (AttributeError, IndexError, TypeError, ValueError):
                continue
            if left <= center_x <= right and line_bottom >= top and line_top <= bottom:
                result.append(line)
        return result

    def bar_lines_for_region(self, region: Any) -> list[int]:
        """Return segmented bar-line x centres that intersect a staff region.

        A system bar line can span several staves, so intersection (rather
        than centre containment on y) deliberately assigns the same physical
        boundary to every staff it crosses. The x centre must still sit inside
        the staff's horizontal extent.
        """
        return sorted(
            {
                round(float(line.center[0]))
                for line in self._lines_for_region(self._detected_bar_lines, region)
            }
        )

    def matched_bar_lines_for_staff(self, region: Any, symbols: list[Any]) -> list[int]:
        """Cross-check decoded bar-line tokens against physical segmentation.

        Attention is monotonic but approximate, while segmentation can include
        stems/rests and can reject a wide repeat line. A boundary is retained
        only when an ordered decoder token has a nearby segmented candidate;
        the returned coordinate is always the physical candidate's x, never
        the attention estimate.
        """
        if region is None or len(region) != 4:
            return []
        left, _top, right, _bottom = [float(value) for value in region]
        left, right = min(left, right), max(left, right)
        width = right - left
        if width <= 0:
            return []
        accepted = self._lines_for_region(self._detected_bar_lines, region)
        candidates = self._lines_for_region(self._bar_line_candidates, region)
        max_distance = max(24.0, width * 0.05)
        selected: list[int] = []
        last_x = float("-inf")
        for symbol in symbols:
            rhythm = str(getattr(symbol, "rhythm", ""))
            if "barline" not in rhythm and not rhythm.startswith("repeat"):
                continue
            attention = _attention_point(getattr(symbol, "coordinates", None))
            if attention is None:
                continue
            target_x = left + max(0.0, min(1.0, attention[0] / MODEL_STAFF_WIDTH)) * width

            def nearest(lines: list[Any]) -> Any:
                eligible = [
                    line
                    for line in lines
                    if float(line.center[0]) > last_x
                    and round(float(line.center[0])) not in selected
                ]
                if not eligible:
                    return None
                return min(eligible, key=lambda line: abs(float(line.center[0]) - target_x))

            match = nearest(accepted)
            if match is None or abs(float(match.center[0]) - target_x) > max_distance:
                match = nearest(candidates)
            if match is None or abs(float(match.center[0]) - target_x) > max_distance:
                continue
            last_x = float(match.center[0])
            selected.append(round(last_x))
        return selected

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
                # The complete decoded sequence, six fields per symbol, in the
                # compact array form. This is what a correction edits and what
                # `/v1/regenerate` turns back into MusicXML, so it must survive
                # the pruning that thins `symbols` down to the uncertain ones.
                # `sort_token_chords` only needs these fields and the `chord`
                # marker, so nothing else has to be carried.
                "tokens": [
                    [
                        symbol.rhythm,
                        symbol.pitch,
                        symbol.lift,
                        symbol.articulation,
                        symbol.slur,
                        symbol.position,
                    ]
                    for symbol in symbols
                ],
                "region": [int(value) for value in region] if region is not None else None,
                # Detected bar lines in page coordinates. These are what make a
                # measure-level crop possible: unlike the attention point they
                # come from segmentation, so they can be trusted as boundaries.
                "barLines": sorted(bar_lines) if bar_lines else [],
                "symbols": entries,
            }
        )

    def assign_voice_systems(self, voices: list[list[Any]]) -> None:
        """Bind physical captures back to HOMR's generated part/voice order.

        `parse_staffs` visits every physical system voice-major, then appends a
        `newline` to each non-empty system before producing one MusicXML part
        per voice. Record that identity only when both views agree exactly.
        """
        if not voices or len(self.staves) % len(voices) != 0:
            return
        systems_per_voice = len(self.staves) // len(voices)
        assignments: list[tuple[dict[str, Any], int, int]] = []
        for part_index, voice in enumerate(voices):
            start = part_index * systems_per_voice
            physical = self.staves[start : start + systems_per_voice]
            decoded_systems = sum(1 for staff in physical if staff.get("tokens"))
            newlines = sum(1 for symbol in voice if getattr(symbol, "rhythm", "") == "newline")
            if decoded_systems != newlines:
                return
            assignments.extend(
                (staff, part_index, system_index)
                for system_index, staff in enumerate(physical)
            )
        for staff, part_index, system_index in assignments:
            staff["partIndex"] = part_index
            staff["systemIndex"] = system_index

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
        from homr import main as homr_main
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

        original_detect_bar_lines = homr_main.detect_bar_lines

        def detect_bar_lines(*args: Any, **kwargs: Any) -> Any:
            lines = original_detect_bar_lines(*args, **kwargs)
            candidates = args[0] if args else kwargs.get("bar_lines", [])
            page.record_detected_bar_lines(lines, candidates)
            return lines

        homr_main.detect_bar_lines = detect_bar_lines
        self._undo.append(
            lambda: setattr(homr_main, "detect_bar_lines", original_detect_bar_lines)
        )

        def parse_staff_image(
            debug: Any, index: int, staff: Any, image: Any, regions: Any, config: Any
        ) -> Any:
            symbols = original_parse(debug, index, staff, image, regions, config)
            region = None
            try:
                region = staff_parsing._calculate_region(staff, regions)
            except Exception:  # pragma: no cover - geometry is best effort
                region = None
            bar_lines = page.matched_bar_lines_for_staff(region, symbols)
            page.add_staff(index, region, symbols, bar_lines)
            return symbols

        staff_parsing.parse_staff_image = parse_staff_image
        self._undo.append(
            lambda: setattr(staff_parsing, "parse_staff_image", original_parse)
        )

        original_parse_staffs = homr_main.parse_staffs

        def parse_staffs(*args: Any, **kwargs: Any) -> Any:
            voices = original_parse_staffs(*args, **kwargs)
            page.assign_voice_systems(voices)
            return voices

        homr_main.parse_staffs = parse_staffs
        self._undo.append(lambda: setattr(homr_main, "parse_staffs", original_parse_staffs))
        return page

    def __exit__(self, *_: Any) -> None:
        _ACTIVE[0] = None
        for undo in reversed(self._undo):
            try:
                undo()
            except Exception:  # pragma: no cover - restoration is best effort
                pass
        self._undo = []
