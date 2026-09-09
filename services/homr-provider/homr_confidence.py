"""Capture per-symbol confidence and page geometry from HOMR, without forking it.

HOMR's decoder already computes what a review UI needs and then discards it. At
every decode step it produces a full logit vector for each of six independent
heads and keeps only the `argmax`:

    rhythm_sample = np.array([[rhythmsp[:, -1, :].argmax()]])

A softmax over those same logits is the confidence, and the top-k are the
alternatives worth offering a user. Nothing here changes what HOMR predicts —
the argmax it would have taken is still the value it reports.

The relevant patch points are all restored on exit:

* `ScoreDecoder.io_binding.get_outputs` — tees each step's distributions. Patched
  on the instance rather than wrapping the object, because `run_with_iobinding`
  is handed the same binding and needs the real one.
* `Staff2Score.predict` and `predict_greedy_with_margins` — capture both the
  legacy and rareNum first-pass decoder paths.
* `ScoreDecoder.rhythm_alternative` — captures a reranker fork and records the
  probability of the value actually forced into that candidate.
* `staff_parsing.parse_staff_image*` — supplies physical staff geometry.
* `homr.main.parse_staffs` — replaces provisional greedy symbols with the final
  reranked voice streams that MusicXML generation actually consumes.

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
        self.regeneration: list[dict[str, Any]] = []
        self._steps: list[list[Any]] = []
        self._decoder: Any = None
        self._page_width = 0
        self._page_height = 0
        # `detect_staffs_in_image` computes trustworthy segmentation boxes for
        # bar lines, but HOMR only uses them while finding/grouping staves and
        # never adds them to `Staff.symbols`. Consequently
        # `Staff.get_bar_lines()` is empty even on an ordinary engraved page.
        # Keep the segmentation result at the page boundary and associate it
        # with physical staff regions below.
        self._detected_bar_lines: list[Any] = []
        self._bar_line_candidates: list[Any] = []
        self.title = ""

    # -- decoder side -----------------------------------------------------

    def reset_steps(self) -> None:
        self._steps = []

    def record_step(self, outputs: Any) -> None:
        # outputs[0:6] are the core logits and [6] is attention. Patched HOMR
        # adds the structured-head hidden representation at [7]; older HOMR
        # builds move directly to the kv cache and have no attach method.
        if len(outputs) < 7:
            return
        hidden = (
            outputs[7].numpy().copy()
            if len(outputs) > 7
            and getattr(self._decoder, "_attach_structured_notation", None) is not None
            else None
        )
        self._steps.append(
            [outputs[i].numpy()[:, -1, :].copy() for i in range(6)]
            + [hidden]
        )

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
            # `rhythm_alternative` teacher-forces its prefix, so HOMR does not
            # attach structured notation there even though the same hidden
            # state is available. Attach it after the fact so a fork-selected
            # symbol is not a hole in either materialization or spot review.
            attach_structured = getattr(self._decoder, "_attach_structured_notation", None)
            if (
                getattr(symbol, "notation", None) is None
                and attach_structured is not None
                and step[6] is not None
            ):
                attach_structured(symbol, step[6])
            heads: dict[str, Any] = {}
            for position, name in enumerate(HEAD_NAMES):
                logits = step[position].reshape(-1).tolist()
                probabilities = _softmax(logits)
                vocabulary = vocabularies[position]
                selected = str(getattr(symbol, name, ""))
                selected_id = next(
                    (token_id for token_id, value in vocabulary.items() if value == selected),
                    None,
                )
                if selected_id is None or selected_id >= len(probabilities):
                    continue
                ranked = _top_k(probabilities, vocabulary, TOP_K)
                heads[name] = {
                    # Usually this is the argmax. A cross-staff reranking fork,
                    # however, deliberately selects a runner-up rhythm and
                    # teacher-forces its prefix. Review must describe that final
                    # selected symbol, not relabel the discarded argmax as chosen.
                    "chosen": selected,
                    "confidence": round(float(probabilities[selected_id]), 6),
                    "alternatives": [
                        candidate for candidate in ranked if candidate["value"] != selected
                    ][: TOP_K - 1],
                }
            setattr(symbol, CONFIDENCE_ATTR, heads)

    # -- page side --------------------------------------------------------

    def record_page_canvas(self, image: Any) -> None:
        try:
            self._page_height, self._page_width = [int(value) for value in image.shape[:2]]
        except (AttributeError, TypeError, ValueError):
            self._page_width = 0
            self._page_height = 0

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
        self,
        index: int,
        region: Any,
        symbols: list[Any],
        bar_lines: Any = None,
        part_index: int | None = None,
        system_index: int | None = None,
        proposal_offset: int = 0,
    ) -> None:
        entries: list[dict[str, Any]] = []
        for ordinal, symbol in enumerate(symbols):
            heads = dict(getattr(symbol, CONFIDENCE_ATTR, None) or {})
            for choice in getattr(symbol, "structured_choices", ()) or ():
                heads[str(choice.head)] = {
                    "chosen": str(choice.value),
                    "confidence": round(float(choice.probability), 6),
                    "alternatives": [
                        {
                            "value": str(alternative.value),
                            "confidence": round(float(alternative.probability), 6),
                        }
                        for alternative in getattr(choice, "alternatives", ())
                        if str(alternative.value) != str(choice.value)
                    ],
                }
            if not heads:
                continue
            coordinates = getattr(symbol, "coordinates", None)
            entries.append(
                {
                    "index": ordinal,
                    "rhythm": symbol.rhythm,
                    "heads": heads,
                    "proposalVoiceIndex": part_index,
                    "proposalSymbolIndex": proposal_offset + ordinal,
                    # Attention-derived and unreliable (HOMR's own caveat); a
                    # highlight hint only, never the crop boundary.
                    "attention": _attention_point(coordinates),
                }
            )
        self.staves.append(
            {
                "index": int(index),
                **({"partIndex": part_index} if part_index is not None else {}),
                **({"systemIndex": system_index} if system_index is not None else {}),
                # The complete decoded sequence, six fields per symbol, in the
                # compact array form. This is what a correction edits and what
                # `/v1/regenerate` turns back into MusicXML, so it must survive
                # the pruning that thins `symbols` down to the uncertain ones.
                # `sort_token_chords` only needs these fields and the `chord`
                # marker, so nothing else has to be carried.
                "tokens": [
                    [
                        str(getattr(symbol, "rhythm", "")),
                        str(getattr(symbol, "pitch", ".")),
                        str(getattr(symbol, "lift", "_")),
                        str(getattr(symbol, "articulation", "_")),
                        str(getattr(symbol, "slur", "_")),
                        str(getattr(symbol, "position", "upper")),
                    ]
                    for symbol in symbols
                ],
                # Parallel to `tokens`, so the provider can later regenerate
                # any selected subset of structured families without repeating
                # model inference. Values are plain JSON scalars, never Python
                # enum implementation details.
                "structured": [
                    _structured_notation(getattr(symbol, "notation", None))
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
        # The rareNum reranking path can replace the first-pass physical-staff
        # symbols after the old capture hook ran. Retain the final voice-major
        # streams returned by parse_staffs so later structured materialization
        # always regenerates exactly what MusicXML generation consumed.
        self.regeneration = [
            {
                "tokens": [
                    [
                        str(getattr(symbol, "rhythm", "")),
                        str(getattr(symbol, "pitch", ".")),
                        str(getattr(symbol, "lift", "_")),
                        str(getattr(symbol, "articulation", "_")),
                        str(getattr(symbol, "slur", "_")),
                        str(getattr(symbol, "position", "upper")),
                    ]
                    for symbol in voice
                ],
                "structured": [
                    _structured_notation(getattr(symbol, "notation", None))
                    for symbol in voice
                ],
            }
            for voice in voices
        ]
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

        final_systems: list[tuple[int, int, int, list[Any]]] = []
        for part_index, voice in enumerate(voices):
            current: list[Any] = []
            offset = 0
            system_index = 0
            for symbol_index, symbol in enumerate(voice):
                if str(getattr(symbol, "rhythm", "")) == "newline":
                    final_systems.append((part_index, system_index, offset, current))
                    current = []
                    offset = symbol_index + 1
                    system_index += 1
                else:
                    current.append(symbol)
            if current:
                final_systems.append((part_index, system_index, offset, current))
        if len(final_systems) != len(self.staves):
            return

        physical = list(self.staves)
        self.staves = []
        for index, ((part_index, system_index, offset, symbols), prior) in enumerate(
            zip(final_systems, physical, strict=True)
        ):
            region = prior.get("region")
            self.add_staff(
                index,
                region,
                symbols,
                self.matched_bar_lines_for_staff(region, symbols),
                part_index,
                system_index,
                offset,
            )

    def as_dict(
        self, source_width: int | None = None, source_height: int | None = None
    ) -> dict[str, Any]:
        """Return geometry in the uploaded source image's coordinate space.

        HOMR normalizes pages to a 1,920px working width before staff parsing.
        The Scanner stores and crops the exact raster it uploaded, so leaking
        working-canvas coordinates makes every region invalid for smaller
        images. Attention stays staff-canvas-local; only page geometry scales.
        """
        if (
            not source_width
            or not source_height
            or self._page_width <= 0
            or self._page_height <= 0
        ):
            return {
                "staves": self.staves,
                "regeneration": self.regeneration,
                "title": self.title,
            }
        scale_x = source_width / self._page_width
        scale_y = source_height / self._page_height
        staves: list[dict[str, Any]] = []
        for staff in self.staves:
            region = staff.get("region")
            scaled_region = (
                [
                    round(float(region[0]) * scale_x),
                    round(float(region[1]) * scale_y),
                    round(float(region[2]) * scale_x),
                    round(float(region[3]) * scale_y),
                ]
                if isinstance(region, list) and len(region) == 4
                else region
            )
            staves.append(
                {
                    **staff,
                    "region": scaled_region,
                    "barLines": [
                        round(float(value) * scale_x) for value in staff.get("barLines", [])
                    ],
                }
            )
        return {
            "staves": staves,
            "regeneration": self.regeneration,
            "title": self.title,
        }


def _structured_notation(notation: Any) -> dict[str, Any] | None:
    if notation is None:
        return None
    return {
        "beamLevels": [str(value) for value in getattr(notation, "beam_levels", ())],
        "stem": str(getattr(notation, "stem", "not_applicable")),
        "tie": str(getattr(notation, "tie", "none")),
        "slurs": [
            [str(event), str(side)]
            for event, side in getattr(notation, "slurs", ())
        ],
        # Dynamic predictions are retained as evidence but the materializer
        # never accepts the dynamic family for output.
        "dynamic": str(getattr(notation, "dynamic", "none")),
        "advance": str(getattr(notation, "advance", "not_applicable")),
    }


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
        from homr.transformer import decoder_inference, staff2score

        page = self.page
        _ACTIVE[0] = page

        original_generate_xml = homr_main.generate_xml

        def generate_xml(args: Any, staffs: Any, title: str) -> Any:
            page.title = str(title or "")
            return original_generate_xml(args, staffs, title)

        homr_main.generate_xml = generate_xml
        self._undo.append(
            lambda: setattr(homr_main, "generate_xml", original_generate_xml)
        )

        original_predict = staff2score.Staff2Score.predict
        original_predict_greedy = getattr(
            staff2score.Staff2Score, "predict_greedy_with_margins", None
        )

        def predict(inner_self: Any, image: Any) -> Any:
            page.attach_decoder(inner_self.decoder)
            page.reset_steps()
            symbols = original_predict(inner_self, image)
            page.stamp(symbols)
            return symbols

        staff2score.Staff2Score.predict = predict
        self._undo.append(lambda: setattr(staff2score.Staff2Score, "predict", original_predict))

        if original_predict_greedy is not None:
            def predict_greedy(inner_self: Any, image: Any, staff_context_emb: Any = None) -> Any:
                page.attach_decoder(inner_self.decoder)
                page.reset_steps()
                result = original_predict_greedy(inner_self, image, staff_context_emb)
                page.stamp(result[0])
                return result

            staff2score.Staff2Score.predict_greedy_with_margins = predict_greedy
            self._undo.append(
                lambda: setattr(
                    staff2score.Staff2Score,
                    "predict_greedy_with_margins",
                    original_predict_greedy,
                )
            )

        original_rhythm_alternative = getattr(
            decoder_inference.ScoreDecoder, "rhythm_alternative", None
        )
        if original_rhythm_alternative is not None:
            def rhythm_alternative(inner_self: Any, *args: Any, **kwargs: Any) -> Any:
                page.attach_decoder(inner_self)
                page.reset_steps()
                symbols = original_rhythm_alternative(inner_self, *args, **kwargs)
                page.stamp(symbols)
                return symbols

            decoder_inference.ScoreDecoder.rhythm_alternative = rhythm_alternative
            self._undo.append(
                lambda: setattr(
                    decoder_inference.ScoreDecoder,
                    "rhythm_alternative",
                    original_rhythm_alternative,
                )
            )

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
            page.record_page_canvas(image)
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

        original_parse_greedy = getattr(
            staff_parsing, "parse_staff_image_greedy_with_margins", None
        )

        def parse_staff_image_greedy(*args: Any, **kwargs: Any) -> Any:
            result = original_parse_greedy(*args, **kwargs)
            # A staff-context second pass revisits the same physical staff. Its
            # final symbols are installed by assign_voice_systems; recording it
            # here would duplicate geometry and destroy the voice/system map.
            positional_context = args[6] if len(args) > 6 else None
            if positional_context is None and kwargs.get("staff_context_emb") is None:
                _debug, index, staff, image, regions, _config = args[:6]
                page.record_page_canvas(image)
                try:
                    region = staff_parsing._calculate_region(staff, regions)
                except Exception:  # pragma: no cover - geometry is best effort
                    region = None
                page.add_staff(
                    index,
                    region,
                    result[0],
                    page.matched_bar_lines_for_staff(region, result[0]),
                )
            return result

        if original_parse_greedy is not None:
            staff_parsing.parse_staff_image_greedy_with_margins = parse_staff_image_greedy
            self._undo.append(
                lambda: setattr(
                    staff_parsing,
                    "parse_staff_image_greedy_with_margins",
                    original_parse_greedy,
                )
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
