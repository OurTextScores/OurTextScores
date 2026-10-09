"""Direction-text and dynamics candidates from full-page OCR rows, for review (never written without a reviewer).

The 2026-10-08 proof of concept found that OCR plus the frozen semantic gate reads written directions far
better than the available direction detectors (24/37 vs 8/37 native words on 10 Lieder pages), so candidates
come from OCR rows, not detector boxes. A row is a *dynamic* when it is exactly a dynamic mark, a *words*
direction when the gate calls it DirectionText and it is a readable word (not a number or a fragment).
Rows already proposed as lyrics are never offered. OCR text is unreviewed.
"""

from __future__ import annotations

import re
from typing import Any, Sequence

DYNAMIC_MARKS = frozenset(
    {"p", "pp", "ppp", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fp", "rf", "rfz", "fz", "sfp"}
)
#: Technical terms and abbreviations that are not sung words in any language: a row starting with one is a
#: direction whatever the lyric-vs-direction gate thinks ("dim. -" was called a lyric).
STRICT_TERMS = frozenset(
    "cresc decresc dim diminuendo crescendo rit ritard ritenuto rall rallent accel allarg dolciss espress "
    "legato staccato pedale ped morendo smorz perdendo calando cantabile marcato sostenuto".split()
)
#: Terms that may follow a fused dynamic mark ("pdolce" = p + dolce). Includes words that are also ordinary
#: Italian words, because only a dynamic-mark prefix is split off.
FUSED_TERMS = STRICT_TERMS | frozenset("dolce poco molto sempre meno più piu con senza tempo".split())
#: Long spelled-out terms engravers spread across a line with hyphens ("cre-  scen-  do"); OCR often drops a hyphen.
LONG_TERMS = (
    "crescendo decrescendo diminuendo ritardando rallentando accelerando ritenuto smorzando perdendosi calando"
).split()
MAX_DIRECTION_ROWS = 120
MAX_CHAIN = 4
_FUSED = re.compile(r"^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fp)\s*([^\W\d_]{3,}\.?)$", re.IGNORECASE | re.UNICODE)
MIN_WORD_LETTERS = 3
_LETTERS = re.compile(r"[^\W\d_]", re.UNICODE)


def _inside(inner, outer) -> bool:
    return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def canonical_dynamic(text: str) -> str | None:
    token = re.sub(r"[\s.,;:!\-_]+", "", text.lower())
    return token if token in DYNAMIC_MARKS else None


def first_token(text: str) -> str:
    match = re.match(r"\s*([^\W\d_]+)", text.lower(), re.UNICODE)
    return match.group(1) if match else ""


def direction_kind(text: str, semantic: str) -> str | None:
    """'dynamic', 'words' or None (not a direction candidate)."""
    if canonical_dynamic(text):
        return "dynamic"
    if first_token(text) in STRICT_TERMS:
        return "words"
    if semantic != "DirectionText":
        return None
    letters = len(_LETTERS.findall(text))
    if letters < MIN_WORD_LETTERS:  # numbers, rehearsal marks, stray syllable fragments
        return None
    return "words"


def direction_rows(rows: Sequence[dict[str, Any]], lyric_boxes: Sequence[Sequence[int]]) -> dict[str, Any]:
    """`rows` are classified OCR rows (box [l,t,r,b], text, ocrConfidence, semantic, semanticScore)."""
    taken = {tuple(box) for box in lyric_boxes}
    out = []
    candidates = [part for row in rows for part in split_fused_dynamic(row)]
    # A merged hyphen chain stands in for its pieces when it reads as a direction word.
    chains = [m for m in merge_hyphen_chains(rows) if m["text"].lower() in LONG_TERMS or first_token(m["text"]) in STRICT_TERMS]
    chained = {tuple(r["box"]) for m in chains for r in rows if _inside(r["box"], m["box"]) and r["text"].strip()}
    candidates = [r for r in candidates if tuple(r["box"]) not in chained] + chains
    for row in candidates:
        strict = first_token(row["text"]) in STRICT_TERMS
        if (tuple(row["box"]) in taken or row.get("proposedLyric")) and not strict:
            continue
        kind = direction_kind(row["text"], row["semantic"] if row["semantic"] else "Unknown")
        if kind is None:
            continue
        out.append({**row, "kind": kind, **({"mark": canonical_dynamic(row["text"])} if kind == "dynamic" else {})})
    out.sort(key=lambda r: (r["box"][1], r["box"][0]))
    return {"rows": out[:MAX_DIRECTION_ROWS], "rowsOmitted": max(0, len(out) - MAX_DIRECTION_ROWS)}


def split_fused_dynamic(row: dict[str, Any]) -> list[dict[str, Any]]:
    """"pdolce" -> a dynamic "p" and the words "dolce", boxes split in proportion to the characters.

    Only when the word after the mark is a known direction term, so ordinary words that start with p or f
    ("poco", "forte") are not cut.
    """
    match = _FUSED.match(row["text"].strip())
    if not match or first_token(match.group(2)) not in FUSED_TERMS:
        return [row]
    mark, word = match.group(1), match.group(2)
    left, top, right, bottom = row["box"]
    cut = left + round((right - left) * len(mark) / (len(mark) + len(word)))
    return [
        {**row, "text": mark, "box": [left, top, cut, bottom]},
        {**row, "text": word, "box": [cut, top, right, bottom]},
    ]


def _continues(pieces: Sequence[dict[str, Any]]) -> bool:
    """A chain goes on while the last piece ends in a hyphen, or the text so far is a proper prefix of a long term."""
    last = pieces[-1]["text"].strip()
    if last.endswith(("-", "–")):
        return True
    so_far = "".join(p["text"].strip().rstrip("-–") for p in pieces).lower()
    return any(term.startswith(so_far) and term != so_far for term in LONG_TERMS) and len(so_far) >= 3


def merge_hyphen_chains(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join a spread-out word ("cre-" ... "scen" ... "do") into one row when read left to right on one line.
    The pieces themselves are left in `rows`; the caller decides whether the merged word is worth offering."""
    merged = []
    for first in rows:
        text = first["text"].strip()
        if len(_LETTERS.findall(text)) < 2 or not (
            text.endswith(("-", "–")) or any(t.startswith(text.lower().rstrip("-–")) for t in LONG_TERMS)
        ):
            continue
        height = max(1, first["box"][3] - first["box"][1])
        chain = [first]
        while len(chain) < MAX_CHAIN and _continues(chain):
            last = chain[-1]
            following = [
                r
                for r in rows
                if r not in chain
                and abs((r["box"][1] + r["box"][3]) - (first["box"][1] + first["box"][3])) <= height
                and 0 <= r["box"][0] - last["box"][2] <= 12 * height
            ]
            if not following:
                break
            chain.append(min(following, key=lambda r: r["box"][0]))
        if len(chain) < 2 or _continues(chain):
            continue
        word = "".join(r["text"].strip().rstrip("-–") for r in chain)
        merged.append(
            {
                **first,
                "text": word,
                "box": [
                    min(r["box"][0] for r in chain),
                    min(r["box"][1] for r in chain),
                    max(r["box"][2] for r in chain),
                    max(r["box"][3] for r in chain),
                ],
                "mergedFrom": len(chain),
            }
        )
    return merged
