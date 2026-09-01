"""Rewrite implied tuplets in a transcription arithmetically, rather than learning them.

An implied tuplet is engraved with no bracket and no numeral - 19th-century printing does
this freely, and it is the model's largest single error class: 84% of rhythm errors are a
tuplet written as plain values. Training data barely moves it, and cannot be expected to.
Raising tuplet supply 70% cut tuplet-token errors ~6% and produced no additional correct
staves. That is the right result for the wrong-looking reason: where the tuplet is
*implied* there is nothing in the pixels to read, so no quantity of examples teaches it.

The arithmetic, however, is decidable without the image. If a bar overruns its staff's
prevailing bar by exactly (written - sounded) * d, and holds a run of `written` values of
duration d, then rewriting that run as a tuplet makes the bar exact. Nothing else produces
that signature, which is what makes this a symbolic pass rather than a model deficiency.

Two constraints keep it honest:

* **Single staves only.** `group_into_chords` attributes a simultaneity's duration once, so
  on a grand staff a bar's total is neither the sum of the hands nor either hand's own
  length (see `is_single_staff`). The premise "this bar is overfull" is not evaluable
  there, so the caller must not offer one.
* **Unambiguous rewrites only.** Where two different tuplets both make the bar exact, the
  arithmetic does not identify which was engraved, and `require_unique` declines rather
  than guessing. This costs recall and is worth it: a wrong rewrite corrupts durations
  that were already right.
"""

import copy
from collections import Counter
from fractions import Fraction

#: Divider tokens, which end a bar and carry no duration.
DIVIDERS = frozenset({
    "barline", "doublebarline", "bolddoublebarline",
    "repeatStart", "repeatEnd", "repeatBoth",
})

#: (written, sounded) for the tuplets engraving actually uses. Ordered most common first
#: so the cheapest hypothesis is tested before the exotic ones.
TUPLETS = ((3, 2), (6, 4), (5, 4), (7, 4), (9, 8))

#: Plain note value -> the value naming the same glyph inside a tuplet. `2` was missing
#: from the first prototype, which lost every half-note triplet - a common shape in slow
#: movements, and 12% of the runs this finds on OSSQ.
PLAIN_TO_TUPLET = {"2": "3", "4": "6", "8": "12", "16": "24", "32": "48"}

#: A bar must exceed the prevailing bar by more than this to be considered overfull at
#: all. Guards against a prevailing estimate that is itself slightly off.
OVERFULL_RATIO = Fraction(21, 20)


def note_value(token: str) -> str | None:
    """The duration part of a note or rest token, or None if it carries no duration."""
    if not token.startswith(("note_", "rest_")):
        return None
    value = token.split("_", 1)[1]
    return value if value.rstrip(".").isdigit() else None


def duration(value: str) -> Fraction:
    dotted = value.endswith(".")
    base = Fraction(1, int(value.rstrip(".")))
    return base * Fraction(3, 2) if dotted else base


def split_bars(tokens: list[str]) -> list[list[str]]:
    """Bars as (content, divider) pairs flattened - dividers are KEPT with their bar.

    The prototype dropped dividers and re-interleaved them on the way out, which silently
    reordered any staff whose divider count did not match its bar count. Keeping each
    divider attached to the bar it closes makes the round trip exact by construction.
    """
    bars: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        current.append(token)
        if token in DIVIDERS:
            bars.append(current)
            current = []
    if current:
        bars.append(current)
    return bars


def simultaneity_durations(bar: list[str]) -> list[Fraction]:
    """One duration per SIMULTANEITY in the bar, chord members counted once.

    `A chord B chord C` is one group sounding together, not three sequential notes -
    real `EncodedSymbol.get_duration()` (`SymbolChord.get_duration` in
    `music_xml_generator.py`) takes the MINIMUM duration across a chord's members, and
    summing every token independently double- (or triple-) counts every chord in the
    bar. Measured on OSSQ: this double-count alone accounted for both staves the repair
    still corrupted after the single-overfull-bar guard - each had an otherwise-correct
    bar containing one two-note chord, reported overfull only because the chord's
    duration was added twice.
    """
    out: list[Fraction] = []
    pending: list[Fraction] = []
    expecting_chord_member = False
    for token in bar:
        if token == "chord":
            expecting_chord_member = True
            continue
        value = note_value(token)
        d = duration(value) if value else None
        if expecting_chord_member and pending:
            if d is not None:
                pending.append(d)
            expecting_chord_member = False
            continue
        if pending:
            out.append(min(pending))
        pending = [d] if d is not None else []
    if pending:
        out.append(min(pending))
    return out


def bar_duration(bar: list[str]) -> Fraction:
    return sum(simultaneity_durations(bar), Fraction(0))


def prevailing_bar(bars: list[list[str]]) -> Fraction | None:
    """The staff's modal bar length, or None if too few bars to establish one.

    Under three bars, a single overfull bar can define the norm and so hide itself.
    """
    lengths = [d for d in map(bar_duration, bars) if d > 0]
    if len(lengths) < 3:
        return None
    modal = Counter(lengths).most_common(1)[0][0]
    return modal if modal > 0 else None


def _runs_of(values: list[str | None], value: str, length: int, contiguous: bool):
    """Index windows holding `length` notes of `value`, contiguously if required."""
    positions = [i for i, v in enumerate(values) if v == value]
    if not contiguous:
        return [positions[:length]] if len(positions) >= length else []
    windows = []
    for start in range(len(positions) - length + 1):
        window = positions[start:start + length]
        if window[-1] - window[0] == length - 1:
            windows.append(window)
    return windows


def repair_bar(bar: list[str], prevailing: Fraction, *, contiguous: bool = True,
               require_unique: bool = True) -> tuple[list[str], tuple | None]:
    """Rewrite one overfull bar as a tuplet, if exactly one rewrite makes it exact.

    Returns the (possibly unchanged) bar and a description of what was rewritten.
    """
    total = bar_duration(bar)
    if total <= prevailing * OVERFULL_RATIO:
        return bar, None
    excess = total - prevailing
    # A rewrite candidate must be plain, sequential notes - never a chord member. Its
    # partner's duration is already excluded from `total` by `simultaneity_durations`
    # (chord = one simultaneity, minimum duration), so a run that grabbed one member
    # would rewrite half a chord into a tuplet while its partner stayed untouched,
    # which is not a real musical shape. `chord_member` marks both neighbours of every
    # `chord` separator so `_runs_of` never proposes a window through one.
    chord_member = [False] * len(bar)
    for i, token in enumerate(bar):
        if token == "chord":
            if i > 0:
                chord_member[i - 1] = True
            if i + 1 < len(bar):
                chord_member[i + 1] = True
    values = [None if chord_member[i] else note_value(t) for i, t in enumerate(bar)]

    candidates = []
    for written, sounded in TUPLETS:
        for plain, tuplet in PLAIN_TO_TUPLET.items():
            if excess != (written - sounded) * duration(plain):
                continue
            for window in _runs_of(values, plain, written, contiguous):
                candidates.append((written, sounded, plain, tuplet, window))

    if not candidates:
        return bar, None
    # Several windows of the SAME rewrite are one hypothesis about the bar's length but
    # several about its position, and picking one at random is a guess like any other.
    distinct = {(w, s, p) for w, s, p, _, _ in candidates}
    if require_unique and (len(distinct) > 1 or len(candidates) > 1):
        return bar, ("ambiguous", len(candidates))

    written, sounded, plain, tuplet, window = candidates[0]
    out = list(bar)
    for index in window:
        out[index] = out[index].replace(f"_{plain}", f"_{tuplet}", 1)
    return out, (f"{written}:{sounded}", plain, tuplet, tuple(window))


def count_overfull(bars: list[list[str]], prevailing: Fraction) -> int:
    return sum(1 for bar in bars if bar_duration(bar) > prevailing * OVERFULL_RATIO)


def repair(tokens: list[str], *, contiguous: bool = True, require_unique: bool = True,
           max_overfull: int | None = 1) -> tuple[list[str], list]:
    """Apply the repair across a single staff. Returns (tokens, rewrites applied).

    Token count is preserved exactly: a tuplet rewrite renames values, it never inserts
    or removes symbols, so the result stays aligned with the other branches (pitch, lift,
    articulation) which are indexed positionally alongside it.
    """
    bars = split_bars(tokens)
    prevailing = prevailing_bar(bars)
    if prevailing is None:
        return tokens, []
    # One isolated overfull bar in an otherwise regular staff is the tuplet signature.
    # SEVERAL overfull bars mean something is wrong with the staff as a whole - a dropped
    # barline, a misread metre - and the prevailing estimate they are measured against is
    # then unreliable too, so "overfull" stops being evidence of a tuplet. Measured on
    # OSSQ: every staff the repair recovered had exactly one overfull bar, while 6 of the
    # 8 it CORRUPTED had two or more.
    if max_overfull is not None and count_overfull(bars, prevailing) > max_overfull:
        return tokens, []
    out: list[str] = []
    rewrites = []
    for bar in bars:
        fixed, what = repair_bar(bar, prevailing, contiguous=contiguous,
                                 require_unique=require_unique)
        if what and what[0] != "ambiguous":
            rewrites.append(what)
        out.extend(fixed)
    return out, rewrites


def is_single_staff(symbols: "list") -> bool:
    """Whether a decoded voice occupies one staff, so its bar durations are unambiguous.

    A grand-staff voice interleaves two staves in one stream (`position` distinguishes
    them), and `EncodedSymbol.get_duration()` attributes a chord's duration once - so a
    bar's total there is neither the sum of the hands nor either hand's own length. This
    mirrors `training.omr_datasets.audit_label_consistency.is_single_staff` exactly; kept
    as a separate copy because that module is training-only and this one runs at
    inference, where importing `training.*` would pull in the training dependency stack.
    """
    return not any(getattr(s, "position", None) == "lower" for s in symbols)


def repair_symbols(symbols: "list", **kwargs) -> tuple["list", list]:
    """Apply the arithmetic repair to a decoded voice's EncodedSymbol stream, in place.

    Only rewrites `.rhythm` - the token whose VALUE changes (note_8 -> note_12); pitch,
    lift, articulation, slur and position never do, so nothing else about the symbol
    needs touching. `repair()` preserves length and order exactly, so index i of the
    input always corresponds to index i of the output and this zip is safe.

    Grand-staff voices are passed through unchanged: `is_single_staff` gates the call, not
    `repair()` itself, since a caller that already knows the voice is single (e.g. having
    just split one) can skip the check.
    """
    if not is_single_staff(symbols):
        return symbols, []
    rhythms = [s.rhythm for s in symbols]
    fixed, rewrites = repair(rhythms, **kwargs)
    if not rewrites:
        return symbols, []
    out = list(symbols)
    for i, (before, after) in enumerate(zip(rhythms, fixed)):
        if before != after:
            out[i] = copy.copy(out[i])
            out[i].rhythm = after
            # Decoding commonly asked the original symbol for its duration before this
            # late repair pass.  A shallow copy carries that cache, so without clearing
            # it `note_8 -> note_12` looked repaired in logs but rendered as the same
            # eighth note in MusicXML.  Rhythm is the cache key; changing it requires
            # a fresh SymbolDuration.
            out[i]._duration = None
    return out, rewrites
