#!/usr/bin/env python3
"""
p0_pipeline.py — PDMX P0 data factory for Gemma 4 E4B OMR training.

Processes PDMX MXL files into (page_image, system_crop, kern) WebDataset shards
+ generic-export JSONL for the Gemma E4B OMR fine-tuning pipeline.

Stages per score:
  0. Filter: stream PDMX.csv, apply quality/license filters
  1. Kern:   MXL → canonical **kern via verovio
  2. Render: MXL → per-page PNGs + SVGs via MuseScore
  3. Segment: SVG StaffLines → system bboxes → system PNG crops
  4. Align:  MusicXML <print new-system> → kern slice per system
  5. Augment: N=3 offline augmentation variants per system crop
  6. Shard:  write WebDataset .tar shards + generic-export/train.jsonl

Usage:
  python3 p0_pipeline.py \\
    --csv "/mnt/bakery/pdmx_dataset/PDMX.csv" \\
    --mxl-root "/mnt/bakery/pdmx_dataset" \\
    --output ./data/p0 \\
    --workers 8 \\
    [--limit 1000] [--dry-run] [--resume] [--aug-n 3]

Requirements (install on data-prep machine):
  apt-get install -y swig libxml2-dev musescore3 xvfb
  pip install verovio pillow albumentations
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator

# ---------------------------------------------------------------------------
# Optional imports — fail gracefully so import errors surface at runtime
# ---------------------------------------------------------------------------
try:
    import verovio as _verovio
    _HAS_VEROVIO = True
except ImportError:
    _HAS_VEROVIO = False

try:
    from PIL import Image as _PILImage
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False

try:
    import albumentations as _A
    import numpy as _np
    _HAS_ALBUMENTATIONS = True
except ImportError:
    _HAS_ALBUMENTATIONS = False

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("p0")


# ===========================================================================
# Stage 0 — PDMX CSV filter
# ===========================================================================

SYSTEM_PROMPT = (
    "Transcribe the music notation in this image to canonical **kern. "
    "Output only the **kern text, nothing else."
)

def _split_for_id(score_id: str) -> str:
    h = int(hashlib.sha256(score_id.encode()).hexdigest(), 16) % 100
    if h < 1:
        return "test"
    if h < 3:
        return "val"
    return "train"


def iter_pdmx_csv(csv_path: str, mxl_root: str, limit: int = 0) -> Iterator[dict]:
    """
    Stream PDMX.csv and yield filtered score dicts.

    Filters applied:
    - subset:no_license_conflict == "True"
    - subset:rated_deduplicated  == "True"
    - n_tracks in [1, 4]
    - 4 <= song_length.bars <= 600
    - mxl file exists on disk
    """
    mxl_root = Path(mxl_root)
    emitted = 0
    skipped = defaultdict(int)

    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if limit and emitted >= limit:
                break

            # License
            if row.get("subset:no_license_conflict", "").strip().lower() != "true":
                skipped["license"] += 1
                continue

            # Deduplication (drop subset:rated — only 5.2% of PDMX has ratings,
            # far too restrictive for a training corpus)
            if row.get("subset:deduplicated", "").strip().lower() != "true":
                skipped["not_deduplicated"] += 1
                continue

            # Staff count proxy: n_tracks
            try:
                n_tracks = int(row.get("n_tracks", "0") or "0")
            except ValueError:
                skipped["bad_n_tracks"] += 1
                continue
            if not (1 <= n_tracks <= 4):
                skipped["track_count"] += 1
                continue

            # Measure count
            try:
                bars = float(row.get("song_length.bars", "0") or "0")
            except ValueError:
                skipped["bad_bars"] += 1
                continue
            if not (4 <= bars <= 600):
                skipped["bar_count"] += 1
                continue

            # MXL path
            mxl_rel = row.get("mxl", "").strip().lstrip("./")
            if not mxl_rel:
                skipped["no_mxl_col"] += 1
                continue
            mxl_path = mxl_root / mxl_rel
            if not mxl_path.exists():
                skipped["mxl_missing"] += 1
                continue

            # Score ID from metadata path
            meta_rel = row.get("metadata", row.get("path", "")).strip()
            score_id = Path(meta_rel).stem if meta_rel else mxl_path.stem

            emitted += 1
            yield {
                "scoreId": score_id,
                "mxlPath": str(mxl_path),
                "composer": row.get("composer_name", "").strip(),
                "title": row.get("song_name", row.get("title", "")).strip(),
                "nTracks": n_tracks,
                "bars": int(bars),
                "split": _split_for_id(score_id),
            }

    log.info("CSV filter done — emitted %d, skipped %s", emitted, dict(skipped))


# ===========================================================================
# Stage 1 — MXL → canonical kern via verovio
# ===========================================================================

# ---------------------------------------------------------------------------
# music21-based MXL → kern serializer
# (Replaces verovio which segfaults on ~70% of PDMX files in Python 3.10/3.11)
# ---------------------------------------------------------------------------

_KERN_PITCH_LETTERS = "CDEFGAB"
_M21_STEP_IDX = {"C": 0, "D": 1, "E": 2, "F": 3, "G": 4, "A": 5, "B": 6}

def _m21_pitch_to_kern(pitch) -> str:
    """Convert a music21 Pitch to a kern pitch token (e.g. 'c', 'G', 'cc#')."""
    step = pitch.step          # 'C','D',...
    octave = pitch.octave      # 4 = middle C octave
    alter = pitch.accidental.alter if pitch.accidental else 0.0

    if octave is None:
        octave = 4

    # Kern octave encoding:
    # octave 4 → lowercase once: c d e f g a b
    # octave 5 → lowercase twice: cc dd …
    # octave 3 → uppercase once: C D …
    # octave 2 → uppercase twice: CC DD …
    if octave >= 4:
        reps = octave - 3
        letter = step.lower() * reps
    else:
        reps = 4 - octave
        letter = step.upper() * reps

    acc = ""
    if alter > 0:
        acc = "#" * int(alter)
    elif alter < 0:
        acc = "-" * int(-alter)

    return letter + acc


def _ql_to_kern_duration(ql: float) -> str:
    """Convert a quarterLength to a kern duration string (e.g. '4', '2.', '8')."""
    # Common exact values
    _TABLE = {
        8.0: "1",   6.0: "1.", 4.0: "2",  3.0: "2.",
        2.0: "4",   1.5: "4.", 1.0: "8",  0.75: "8.",
        0.5: "16",  0.375: "16.", 0.25: "32", 0.125: "64",
    }
    # Also whole note = 4 quarterLengths
    table = {4.0: "1", 3.0: "1.", 2.0: "2", 1.5: "2.", 1.0: "4", 0.75: "4.",
             0.5: "8", 0.375: "8.", 0.25: "16", 0.125: "32", 0.0625: "64"}
    if ql in table:
        return table[ql]
    # Fallback: find nearest
    best = min(table.keys(), key=lambda k: abs(k - ql))
    return table[best]


def _m21_clef_to_kern(clef) -> str:
    """Convert music21 clef to kern *clef token."""
    if clef is None:
        return "*clefG2"
    name = type(clef).__name__
    if "Treble" in name or "G" in name:
        return "*clefG2"
    if "Bass" in name or "F" in name:
        return "*clefF4"
    if "Alto" in name:
        return "*clefC3"
    if "Tenor" in name:
        return "*clefC4"
    return "*clefG2"


def _m21_key_to_kern(key_sig) -> str:
    """Convert music21 KeySignature/Key to kern *k[] token."""
    if key_sig is None:
        return "*k[]"
    sharps = key_sig.sharps
    if sharps == 0:
        return "*k[]"
    order_sharps = ["f#", "c#", "g#", "d#", "a#", "e#", "b#"]
    order_flats  = ["b-", "e-", "a-", "d-", "g-", "c-", "f-"]
    if sharps > 0:
        tokens = order_sharps[:sharps]
    else:
        tokens = order_flats[:-sharps]  # sharps is negative
    return "*k[" + "".join(tokens) + "]"


def _m21_timesig_to_kern(ts) -> str:
    if ts is None:
        return "*M4/4"
    return f"*M{ts.numerator}/{ts.denominator}"


def _note_to_kern_token(note, beam_start: bool = False, beam_end: bool = False) -> str:
    """Convert a music21 Note or Rest to a kern note token."""
    dur = _ql_to_kern_duration(note.duration.quarterLength)
    if note.isRest:
        token = dur + "r"
    elif hasattr(note, "pitches"):
        # Chord — sort pitches ascending
        pitches = sorted(note.pitches, key=lambda p: p.midi)
        token = " ".join(dur + _m21_pitch_to_kern(p) for p in pitches)
    else:
        token = dur + _m21_pitch_to_kern(note.pitch)

    # Tie
    if hasattr(note, "tie") and note.tie:
        if note.tie.type == "start":
            token = token + "["
        elif note.tie.type == "stop":
            token = token + "]"
        elif note.tie.type == "continue":
            token = token + "_"

    return token


def mxl_to_kern(mxl_path: str, timeout: int = 60) -> str | None:
    """
    Convert MXL/MusicXML to **kern using music21.
    Reliable replacement for verovio which segfaults on ~70% of PDMX files.
    Returns canonical kern string, or None on failure.
    """
    try:
        import music21
        score = music21.converter.parse(mxl_path)
    except Exception as exc:
        log.debug("music21 parse failed %s: %s", mxl_path, exc)
        return None

    try:
        parts = list(score.parts)
        if not parts:
            return None

        # Build kern for each part as a spine
        spines: list[list[str]] = [[] for _ in parts]

        for spine_idx, part in enumerate(parts):
            spine = spines[spine_idx]
            spine.append("**kern")

            # Collect context from first measure
            first_m = next(iter(part.getElementsByClass("Measure")), None)
            clef = part.recurse().getElementsByClass("Clef").first()
            key_sig = part.recurse().getElementsByClass("KeySignature").first()
            ts = part.recurse().getElementsByClass("TimeSignature").first()

            spine.append(_m21_clef_to_kern(clef))
            spine.append(_m21_key_to_kern(key_sig))
            spine.append(_m21_timesig_to_kern(ts))

            for measure in part.getElementsByClass("Measure"):
                m_num = measure.number or 1
                spine.append(f"={m_num}")

                # Update context mid-score
                for elem in measure:
                    if isinstance(elem, music21.clef.Clef):
                        spine.append(_m21_clef_to_kern(elem))
                    elif isinstance(elem, music21.key.KeySignature):
                        spine.append(_m21_key_to_kern(elem))
                    elif isinstance(elem, music21.meter.TimeSignature):
                        spine.append(_m21_timesig_to_kern(elem))
                    elif isinstance(elem, (music21.note.Note,
                                           music21.note.Rest,
                                           music21.chord.Chord)):
                        spine.append(_note_to_kern_token(elem))

            spine.append("==")
            spine.append("*-")

        # If single part, emit as single-column kern
        if len(spines) == 1:
            return "\n".join(spines[0]) + "\n"

        # Multi-part: zip spines with tab separator
        # Pad shorter spines to equal length
        max_len = max(len(s) for s in spines)
        for s in spines:
            while len(s) < max_len:
                s.append(".")

        lines = ["\t".join(row[i] for row in spines) for i in range(max_len)]
        return "\n".join(lines) + "\n"

    except Exception as exc:
        log.debug("kern serialization failed %s: %s", mxl_path, exc)
        return None


# ===========================================================================
# Kern normalization (Transcoda rules)
# ===========================================================================

def normalize_kern(kern_text: str) -> tuple[str, dict]:
    """
    Apply the 4 confirmed Transcoda normalization rules + baseline cleanup.
    Returns (normalized_text, report_dict).
    """
    report: dict[str, int] = {
        "spines_stripped": 0,
        "visual_tokens_removed": 0,
        "accidentals_repaired": 0,
        "ties_repaired": 0,
        "redundant_metadata_removed": 0,
    }

    lines = kern_text.split("\n")
    out_lines: list[str] = []

    # Identify spine count from ** header line
    spine_types: list[str] = []
    kern_spine_indices: list[int] = []
    for line in lines:
        if line.startswith("**"):
            spine_types = re.split(r"\t", line)
            kern_spine_indices = [i for i, s in enumerate(spine_types)
                                  if s.strip() == "**kern"]
            break

    prev_timesig: str | None = None

    for line in lines:
        # Baseline: normalize line endings
        line = line.rstrip("\r")

        # Rule 1 — strip non-kern spines: only keep **kern columns
        if "\t" in line and kern_spine_indices:
            cols = line.split("\t")
            if len(cols) == len(spine_types):
                kept = [cols[i] for i in kern_spine_indices]
                if len(kept) < len(cols):
                    report["spines_stripped"] += 1
                    line = "\t".join(kept)

        # Rule 2 — visual-semantic: remove grace rests (qq tokens with r)
        if re.search(r'\bqq?r\b', line):
            report["visual_tokens_removed"] += 1
            continue

        # Rule 4 — redundant *met → already have *M time signature
        if line.startswith("*met("):
            report["redundant_metadata_removed"] += 1
            continue

        if re.match(r'^\*M\d+/', line.strip()):
            prev_timesig = line.strip()

        # Rule 4 — self-canceling ties: token[]  → remove tie
        line = re.sub(r'(\d+[A-Ga-g][^#n\s]*)\[\]', r'\1', line)
        if '[]' not in line and re.search(r'\[\]', line):
            report["ties_repaired"] += 1

        # Rule 4 — conflicting accidentals: #n or n# → keep last
        def _fix_accidental(m: re.Match) -> str:
            report["accidentals_repaired"] += 1
            tok = m.group(0)
            # keep only the last accidental modifier
            tok = re.sub(r'[#n-]+([#n-])', r'\1', tok)
            return tok
        line = re.sub(r'\d[A-Ga-g][#n-]{2,}', _fix_accidental, line)

        # Rule 3 — chord note sorting: chord tokens are space-separated in a tab cell;
        # sort each chord group by pitch (simplified: sort by pitch letter + octave)
        # Only attempt if line looks like note data (starts with digit or space+digit)
        if re.match(r'^\s*\d', line) and " " in line:
            line = _sort_chord_notes(line)

        out_lines.append(line)

    result = "\n".join(out_lines)

    # Baseline: ensure **kern spine declaration and *- terminator
    if "**kern" not in result:
        result = "**kern\n" + result
    if not result.rstrip().endswith("*-"):
        result = result.rstrip() + "\n*-\n"

    return result, report


_PITCH_ORDER = "cCdDeEfFgGaAbB"

def _pitch_rank(token: str) -> int:
    """Very simplified pitch rank for chord sorting (ignores octave dots for now)."""
    m = re.search(r'[A-Ga-g]', token)
    if not m:
        return 0
    letter = m.group(0)
    base = _PITCH_ORDER.find(letter)
    # Count octave: lowercase = above middle, uppercase = below; dots refine
    octave = token.count("'") - token.count(",")
    return base + octave * 14


def _sort_chord_notes(line: str) -> str:
    """Sort chord notes within each tab column by pitch (ascending)."""
    cols = line.split("\t")
    result_cols = []
    for col in cols:
        if " " in col and re.search(r'\d', col):
            notes = col.split(" ")
            notes.sort(key=_pitch_rank)
            result_cols.append(" ".join(notes))
        else:
            result_cols.append(col)
    return "\t".join(result_cols)


def validate_kern(kern_text: str) -> list[str]:
    """Return list of validation error strings; empty = valid."""
    errors = []
    if "**kern" not in kern_text:
        errors.append("missing **kern spine")
    if not re.search(r'(^|\n)\*-', kern_text):
        errors.append("missing *- terminator")
    if not re.search(r'(^|\n)\*clef', kern_text):
        errors.append("missing clef token")
    # Check for impossible accidentals (triple+ modifiers)
    if re.search(r'[#n-]{3,}', kern_text):
        errors.append("impossible accidental run")
    return errors


# ===========================================================================
# Stage 2 — MuseScore render → per-page PNGs + SVGs
# ===========================================================================

_MUSESCORE_CANDIDATES = [
    "musescore3", "musescore", "MuseScore3",
    "musescore4", "mscore4portable", "MuseScore4",
]

def _find_musescore() -> str | None:
    # Prefer musescore3 — musescore4 AppImage often has RC=40 in Docker environments
    # and bundles its own xvfb-run which conflicts with our wrapper.
    for candidate in _MUSESCORE_CANDIDATES:
        if shutil.which(candidate):
            return candidate
    return None


def render_score(mxl_path: str, out_dir: Path, dpi: int = 150,
                 timeout: int = 120, svg_only: bool = False) -> dict[str, list[Path]]:
    """
    Render MXL/MusicXML to per-page PNGs and/or SVGs.
    svg_only=True skips the PNG render (used when PNGs pre-exist from p0-render.mjs).
    Returns {"png": [page1.png, …], "svg": [page1.svg, …]}.
    On failure returns {"png": [], "svg": []}.
    """
    mscore = _find_musescore()
    if not mscore:
        raise RuntimeError("MuseScore not found on PATH")

    out_dir.mkdir(parents=True, exist_ok=True)

    def _run(output_suffix: str, extra_args: list[str]) -> list[Path]:
        out_base = out_dir / f"output.{output_suffix}"
        cmd = [mscore, "-platform", "offscreen"] + extra_args + ["-o", str(out_base), mxl_path]

        # Wrap with xvfb-run if available
        xvfb = shutil.which("xvfb-run")
        if xvfb:
            cmd = [xvfb, "-a"] + cmd

        try:
            subprocess.run(
                cmd,
                timeout=timeout,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except subprocess.TimeoutExpired:
            log.debug("MuseScore timed out: %s", mxl_path)
            return []

        # Collect output files: output.ext, output-1.ext, output-01.ext, …
        pattern = re.compile(rf'^output[-.]?\d*\.{output_suffix}$', re.IGNORECASE)
        found = sorted(
            out_dir.glob(f"output*.{output_suffix}"),
            key=lambda p: int(re.search(r'\d+', p.stem[6:] or "0").group() or "0")
            if re.search(r'\d+', p.stem[6:] or "0") else 0,
        )
        found = [f for f in found if pattern.match(f.name)]
        if not found:
            # Single-page fallback: output.ext with no number
            single = out_dir / f"output.{output_suffix}"
            if single.exists():
                found = [single]
        return found

    png_pages = [] if svg_only else _run("png", ["-r", str(dpi)])
    svg_pages = _run("svg", [])

    return {"png": png_pages, "svg": svg_pages}


# ===========================================================================
# Stage 3 — SVG StaffLines → system bboxes → PNG crops
# ===========================================================================

def _parse_stafflines_ys(svg_text: str) -> list[float]:
    """Extract all unique y-values from class="StaffLines" polylines."""
    ys: list[float] = []
    for m in re.finditer(r'class="StaffLines"[^>]*points="([^"]+)"', svg_text):
        for pt in m.group(1).strip().split():
            if "," in pt:
                _, y_str = pt.split(",", 1)
                try:
                    ys.append(float(y_str))
                except ValueError:
                    pass
    return sorted(set(round(y, 1) for y in ys))


def _get_svg_viewbox(svg_text: str) -> tuple[float, float] | None:
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg_text)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None


def segment_systems(svg_text: str, png_width: int, png_height: int) -> list[dict]:
    """
    Return list of system bbox dicts: {y1, y2, stave_count}.
    Returns [] for title/front-matter pages (no StaffLines).
    """
    unique_ys = _parse_stafflines_ys(svg_text)
    if not unique_ys:
        return []

    vb = _get_svg_viewbox(svg_text)
    if not vb:
        return []
    svg_w, svg_h = vb

    # Group y-values into individual 5-line staves
    staves = [unique_ys[i:i + 5] for i in range(0, len(unique_ys), 5)]
    if len(staves) < 1:
        return []

    if len(staves) == 1:
        # Single staff — one system
        all_ys = staves[0]
        line_spacing = (all_ys[-1] - all_ys[0]) / 4 if len(all_ys) >= 5 else 25.0
        padding = line_spacing * 2
        scale_y = png_height / svg_h
        y1 = max(0, int((all_ys[0] - padding) * scale_y))
        y2 = min(png_height, int((all_ys[-1] + padding) * scale_y))
        if y2 - y1 < 50:
            return []
        return [{"y1": y1, "y2": y2, "stave_count": 1}]

    # Inter-staff gaps
    gaps = [staves[i + 1][0] - staves[i][-1] for i in range(len(staves) - 1)]
    sorted_gaps = sorted(gaps)

    # Auto-threshold: midpoint of the largest jump
    if len(sorted_gaps) == 1:
        # All staves form one system
        systems_staves = [staves]
    else:
        jump_diffs = [(sorted_gaps[i + 1] - sorted_gaps[i], i)
                      for i in range(len(sorted_gaps) - 1)]
        max_jump_idx = max(jump_diffs, key=lambda x: x[0])[1]
        threshold = (sorted_gaps[max_jump_idx] + sorted_gaps[max_jump_idx + 1]) / 2

        systems_staves: list[list] = []
        current = [staves[0]]
        for gap, stave in zip(gaps, staves[1:]):
            if gap > threshold:
                systems_staves.append(current)
                current = [stave]
            else:
                current.append(stave)
        systems_staves.append(current)

    # Estimate line spacing from first staff
    first_staff = staves[0]
    line_spacing = ((first_staff[-1] - first_staff[0]) / 4
                    if len(first_staff) >= 5 else 25.0)
    padding = line_spacing * 2
    scale_y = png_height / svg_h

    result = []
    for sys_staves in systems_staves:
        all_ys = [y for s in sys_staves for y in s]
        y1 = max(0, int((min(all_ys) - padding) * scale_y))
        y2 = min(png_height, int((max(all_ys) + padding) * scale_y))
        if y2 - y1 < 50:
            continue
        result.append({"y1": y1, "y2": y2, "stave_count": len(sys_staves)})

    return result


def crop_system(png_path: Path, y1: int, y2: int, out_path: Path) -> bool:
    """Crop a system strip from a page PNG. Returns True on success."""
    if not _HAS_PIL:
        raise RuntimeError("Pillow not installed — run: pip install pillow")
    try:
        img = _PILImage.open(png_path)
        w, h = img.size
        crop = img.crop((0, y1, w, y2))
        crop.save(out_path, format="PNG", optimize=True)
        return True
    except Exception as exc:
        log.debug("crop failed %s: %s", png_path, exc)
        return False


# ===========================================================================
# Stage 4 — MusicXML system-break alignment → kern slices
# ===========================================================================

def get_system_measure_ranges(mxl_path: str) -> list[tuple[int, int]]:
    """
    Parse <print new-system="yes"> markers from MuseScore-exported MusicXML.
    Returns [(start, end), …] one tuple per system, across all pages.
    Confirmed present in MuseScore 3 exports (250 occurrences in Goldberg).
    """
    path = Path(mxl_path)
    try:
        if path.suffix.lower() == ".mxl":
            import zipfile
            with zipfile.ZipFile(path) as zf:
                xml_names = [n for n in zf.namelist()
                             if n.endswith(".xml") and not n.startswith("META-INF")]
                if not xml_names:
                    return []
                xml_text = zf.read(xml_names[0]).decode("utf-8", errors="replace")
        else:
            xml_text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    # Strip namespace for simple parsing
    xml_text = re.sub(r'\s+xmlns[^=]*="[^"]*"', "", xml_text, count=5)
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    ranges: list[tuple[int, int]] = []
    current_start = 1
    last_num = 1

    for m in root.iter("measure"):
        raw = m.get("number", "")
        try:
            measure_num = int(raw)
        except ValueError:
            continue
        last_num = measure_num
        print_el = m.find("print")
        is_break = print_el is not None and (
            print_el.get("new-system") == "yes" or
            print_el.get("new-page") == "yes"
        )
        if is_break and measure_num > current_start:
            ranges.append((current_start, measure_num - 1))
            current_start = measure_num

    if last_num >= current_start:
        ranges.append((current_start, last_num))

    return ranges


def slice_kern_measures(kern_text: str, start: int, end: int) -> str:
    """
    Extract measures start..end (inclusive) from full-score kern via text slicing.
    Prepends current **kern spine + clef/key/time context.
    Confirmed approach: all headers preserved regardless of excerpt position.
    """
    lines = kern_text.split("\n")

    spine_lines = [l for l in lines if l.startswith("**")]
    current_clef: list[str] = []
    current_key: list[str] = []
    current_time: list[str] = []
    in_range = False
    body: list[str] = []

    for line in lines:
        stripped = line.strip()

        # Track context (update even outside range)
        if re.match(r'\*clef', stripped):
            current_clef = [line]
        if re.match(r'\*k\[', stripped, re.IGNORECASE):
            current_key = [line]
        if re.match(r'\*M\d', stripped):
            current_time = [line]

        # Detect barlines
        bar_m = re.match(r'^(=+)(\d+)', stripped)
        if bar_m:
            m_num = int(bar_m.group(2))
            if m_num == start:
                in_range = True
            elif m_num > end:
                in_range = False

        # Final barline / terminator ends range
        if re.match(r'^=+$', stripped) or stripped == "*-":
            if in_range:
                body.append(line)
            in_range = False
            continue

        if in_range:
            body.append(line)

    context = current_clef + current_key + current_time
    excerpt_lines = spine_lines + context + body + ["*-"]
    return "\n".join(l for l in excerpt_lines if l is not None) + "\n"


def page_kern_from_ranges(kern_text: str, system_ranges: list[tuple[int, int]],
                           page_system_indices: list[int]) -> str:
    """Build page-grain kern covering all systems on a given page."""
    if not page_system_indices:
        return ""
    s = system_ranges[page_system_indices[0]][0]
    e = system_ranges[page_system_indices[-1]][1]
    return slice_kern_measures(kern_text, s, e)


# ===========================================================================
# Stage 5 — Augmentation
# ===========================================================================

def _build_augmentation_pipeline():
    """Build albumentations pipeline matching the P0 design policy."""
    if not _HAS_ALBUMENTATIONS:
        return None
    return _A.Compose([
        _A.SafeRotate(limit=2.0, p=0.5),
        _A.Perspective(scale=(0.01, 0.03), p=0.3),
        _A.RandomBrightnessContrast(brightness_limit=0.15, contrast_limit=0.15, p=0.6),
        _A.GaussianBlur(blur_limit=(1, 3), p=0.3),
        _A.GaussNoise(std_range=(0.01, 0.04), p=0.4),
        _A.ImageCompression(quality_range=(60, 95), p=0.3),
        _A.CoarseDropout(num_holes_range=(1, 3), hole_height_range=(5, 20),
                         hole_width_range=(5, 40), p=0.2),
    ], p=1.0)


_AUG_PIPELINE = None


def augment_image(img_path: Path, out_path: Path, seed: int) -> bool:
    """Apply one augmentation variant and save to out_path."""
    global _AUG_PIPELINE
    if not _HAS_ALBUMENTATIONS or not _HAS_PIL:
        return False
    if _AUG_PIPELINE is None:
        _AUG_PIPELINE = _build_augmentation_pipeline()
    try:
        img = _PILImage.open(img_path).convert("RGB")
        arr = _np.array(img)
        result = _AUG_PIPELINE(image=arr)
        aug_img = _PILImage.fromarray(result["image"])
        aug_img.save(out_path, format="PNG", optimize=True)
        return True
    except Exception as exc:
        log.debug("augment failed %s: %s", img_path, exc)
        return False


# ===========================================================================
# Stage 6 — WebDataset sharding + generic-export JSONL
# ===========================================================================

class ShardWriter:
    """Writes WebDataset-compatible .tar shards, one triple per example."""

    def __init__(self, shard_dir: Path, split: str, shard_size: int = 1000):
        self.shard_dir = shard_dir / split
        self.shard_dir.mkdir(parents=True, exist_ok=True)
        self.split = split
        self.shard_size = shard_size
        self._shard_idx = 0
        self._count = 0
        self._tf: tarfile.TarFile | None = None
        self._open_shard()

    def _open_shard(self):
        if self._tf:
            self._tf.close()
        name = self.shard_dir / f"{self.split}-{self._shard_idx:06d}.tar"
        self._tf = tarfile.open(name, "w")

    def write(self, key: str, png_path: Path, kern_text: str, meta: dict):
        assert self._tf is not None
        # PNG
        self._tf.add(png_path, arcname=f"{key}.png")
        # kern
        kern_bytes = kern_text.encode("utf-8")
        ti = tarfile.TarInfo(name=f"{key}.kern")
        ti.size = len(kern_bytes)
        self._tf.addfile(ti, io.BytesIO(kern_bytes))
        # metadata JSON
        meta_bytes = json.dumps(meta, ensure_ascii=False).encode("utf-8")
        ti2 = tarfile.TarInfo(name=f"{key}.json")
        ti2.size = len(meta_bytes)
        self._tf.addfile(ti2, io.BytesIO(meta_bytes))

        self._count += 1
        if self._count % self.shard_size == 0:
            self._shard_idx += 1
            self._open_shard()

    def close(self):
        if self._tf:
            self._tf.close()
            self._tf = None

    @property
    def total(self):
        return self._count


class GenericExportWriter:
    """Writes generic-export/train.jsonl (used by training scripts directly)."""

    def __init__(self, export_dir: Path, split: str):
        export_dir.mkdir(parents=True, exist_ok=True)
        path = export_dir / f"{split}.jsonl"
        self._fh = open(path, "a", encoding="utf-8")

    def write(self, example_id: str, crop_rel_path: str,
              kern_text: str, measure_start: int, measure_end: int):
        row = {
            "exampleId": example_id,
            "taskType": "transcribe_local_passage",
            "system": SYSTEM_PROMPT,
            "input": {
                "region": {"measureStart": measure_start, "measureEnd": measure_end},
                "imageRefs": {"region": crop_rel_path},
            },
            "target": {
                "candidate": {"content": kern_text},
                "overall_confidence": 1.0,
                "findings": [],
                "evidence_spans": [{"measureStart": measure_start, "measureEnd": measure_end}],
            },
        }
        self._fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    def close(self):
        self._fh.close()


# ===========================================================================
# Per-score worker
# ===========================================================================

def process_score(args: tuple) -> dict:
    """
    Process one PDMX score through all pipeline stages.
    Runs in a subprocess worker. Returns a result dict.
    """
    (score_id, mxl_path, composer, title, n_tracks, bars,
     split, output_dir, aug_n, dry_run) = args

    output_dir = Path(output_dir)
    kern_dir = output_dir / "kern"
    render_dir = output_dir / "render" / split
    crops_dir = output_dir / "crops" / split
    errors: list[str] = []
    examples: list[dict] = []  # for shard writing in caller

    kern_dir.mkdir(parents=True, exist_ok=True)
    render_dir.mkdir(parents=True, exist_ok=True)
    crops_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Stage 1: MXL → canonical kern
    # ------------------------------------------------------------------
    kern_path = kern_dir / f"{score_id}.kern"
    if not kern_path.exists():
        if dry_run:
            return {"scoreId": score_id, "ok": True, "dry_run": True, "examples": []}

        raw_kern = mxl_to_kern(mxl_path)
        if not raw_kern:
            return {"scoreId": score_id, "ok": False, "reason": "kern_failed"}

        normalized, norm_report = normalize_kern(raw_kern)
        validation_errors = validate_kern(normalized)
        if validation_errors:
            return {"scoreId": score_id, "ok": False,
                    "reason": "kern_invalid:" + ";".join(validation_errors)}

        kern_path.write_text(normalized, encoding="utf-8")
        (kern_dir / f"{score_id}.norm.json").write_text(
            json.dumps(norm_report), encoding="utf-8"
        )
    else:
        normalized = kern_path.read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # Stage 2: MuseScore render (skip if p0-render.mjs already did it)
    # ------------------------------------------------------------------
    # Check for pre-rendered PNGs from the parallel render container.
    # SVGs are always re-generated to a tmpdir (not kept by render container).
    pre_rendered_pngs = sorted(render_dir.glob(f"{score_id}-p*.png"))

    with tempfile.TemporaryDirectory(prefix=f"p0-{score_id}-") as tmp:
        tmp_path = Path(tmp)

        if pre_rendered_pngs:
            # PNGs already exist — only render SVGs (halves MuseScore invocations)
            svg_result = render_score(mxl_path, tmp_path, dpi=150, timeout=120, svg_only=True)
            svg_pages = svg_result["svg"]
            saved_pngs = pre_rendered_pngs
        else:
            render_result = render_score(mxl_path, tmp_path, dpi=150, timeout=120)
            png_pages = render_result["png"]
            svg_pages = render_result["svg"]

            if not png_pages:
                return {"scoreId": score_id, "ok": False, "reason": "render_no_png"}

            saved_pngs = []
            for i, src in enumerate(png_pages, 1):
                dst = render_dir / f"{score_id}-p{i:02d}.png"
                if not dst.exists():
                    shutil.copy2(src, dst)
                saved_pngs.append(dst)

        # ------------------------------------------------------------------
        # Stage 3 + 4: segment & align per page
        # ------------------------------------------------------------------
        system_ranges = get_system_measure_ranges(mxl_path)
        system_cursor = 0  # index into system_ranges across all pages

        for page_idx, (png_path, svg_path) in enumerate(
                zip(saved_pngs, svg_pages), 1
        ):
            # Load SVG
            try:
                svg_text = svg_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            # Get PNG dimensions
            try:
                img = _PILImage.open(png_path)
                png_w, png_h = img.size
                img.close()
            except Exception:
                continue

            systems = segment_systems(svg_text, png_w, png_h)
            if not systems:
                continue  # title page — skip

            page_system_indices: list[int] = []

            for sys_idx, sys_bbox in enumerate(systems):
                # Map this visual system to a kern measure range
                if system_cursor >= len(system_ranges):
                    break

                m_start, m_end = system_ranges[system_cursor]
                page_system_indices.append(system_cursor)
                system_cursor += 1

                # Crop
                crop_name = f"{score_id}-p{page_idx:02d}-s{sys_idx:02d}"
                crop_path = crops_dir / f"{crop_name}.png"
                if not crop_path.exists():
                    ok = crop_system(png_path, sys_bbox["y1"], sys_bbox["y2"], crop_path)
                    if not ok:
                        continue

                # Kern excerpt
                excerpt_kern = slice_kern_measures(normalized, m_start, m_end)
                excerpt_path = crops_dir / f"{crop_name}.kern"
                if not excerpt_path.exists():
                    excerpt_path.write_text(excerpt_kern, encoding="utf-8")

                # Augmented variants
                aug_paths: list[Path] = []
                for aug_i in range(aug_n):
                    aug_seed = int(hashlib.sha256(
                        f"{score_id}-{page_idx}-{sys_idx}-{aug_i}".encode()
                    ).hexdigest(), 16) % (2 ** 31)
                    aug_name = f"{crop_name}-aug{aug_i}"
                    aug_path = crops_dir / f"{aug_name}.png"
                    if not aug_path.exists():
                        augment_image(crop_path, aug_path, seed=aug_seed)
                    if aug_path.exists():
                        aug_paths.append(aug_path)

                examples.append({
                    "exampleId": crop_name,
                    "scoreId": score_id,
                    "split": split,
                    "grain": "system",
                    "pageIndex": page_idx,
                    "systemIndex": sys_idx,
                    "measureStart": m_start,
                    "measureEnd": m_end,
                    "staffCount": sys_bbox["stave_count"],
                    "cropPath": str(crop_path),
                    "kernPath": str(excerpt_path),
                    "augPaths": [str(p) for p in aug_paths],
                    "composer": composer,
                    "title": title,
                    "nTracks": n_tracks,
                    "bars": bars,
                })

            # Page-grain example
            if page_system_indices and system_ranges:
                page_kern = page_kern_from_ranges(
                    normalized, system_ranges, page_system_indices
                )
                page_kern_path = crops_dir / f"{score_id}-p{page_idx:02d}.kern"
                if not page_kern_path.exists() and page_kern:
                    page_kern_path.write_text(page_kern, encoding="utf-8")
                examples.append({
                    "exampleId": f"{score_id}-p{page_idx:02d}",
                    "scoreId": score_id,
                    "split": split,
                    "grain": "page",
                    "pageIndex": page_idx,
                    "systemIndex": None,
                    "measureStart": system_ranges[page_system_indices[0]][0]
                        if page_system_indices else None,
                    "measureEnd": system_ranges[page_system_indices[-1]][1]
                        if page_system_indices else None,
                    "staffCount": None,
                    "cropPath": str(png_path),
                    "kernPath": str(page_kern_path),
                    "augPaths": [],
                    "composer": composer,
                    "title": title,
                    "nTracks": n_tracks,
                    "bars": bars,
                })

    return {
        "scoreId": score_id,
        "ok": True,
        "examples": examples,
        "errors": errors,
    }


# ===========================================================================
# Main orchestrator
# ===========================================================================

def main():
    parser = argparse.ArgumentParser(description="PDMX P0 data pipeline")
    parser.add_argument("--csv", required=True, help="Path to PDMX.csv")
    parser.add_argument("--mxl-root", required=True,
                        help="Root dir containing the extracted mxl/ tree")
    parser.add_argument("--output", default="./data/p0",
                        help="Output directory (default: ./data/p0)")
    parser.add_argument("--workers", type=int, default=4,
                        help="Parallel workers (default: 4)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max scores to process (0 = all)")
    parser.add_argument("--aug-n", type=int, default=3,
                        help="Augmentation variants per system crop (default: 3)")
    parser.add_argument("--shard-size", type=int, default=1000,
                        help="Examples per WebDataset shard (default: 1000)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Filter only, no rendering or writing")
    parser.add_argument("--resume", action="store_true",
                        help="Skip scores whose kern file already exists")
    args = parser.parse_args()

    # Validate dependencies
    if not args.dry_run:
        if not _HAS_VEROVIO:
            log.error("verovio not installed. Run: pip install verovio")
            sys.exit(1)
        if not _HAS_PIL:
            log.error("Pillow not installed. Run: pip install pillow")
            sys.exit(1)
        if not _find_musescore():
            log.error("MuseScore not found on PATH. Install musescore3 or musescore4.")
            sys.exit(1)
        if not _HAS_ALBUMENTATIONS:
            log.warning("albumentations not installed — augmentation will be skipped")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Progress / checkpoint file
    done_path = output_dir / "p0-done.txt"
    done_ids: set[str] = set()
    if args.resume and done_path.exists():
        done_ids = set(done_path.read_text().splitlines())
        log.info("Resuming — %d scores already done", len(done_ids))

    manifest_path = output_dir / "p0-manifest.jsonl"
    errors_path = output_dir / "p0-errors.jsonl"

    # Shard writers (one per split)
    shards: dict[str, ShardWriter] = {}
    ge_writers: dict[str, GenericExportWriter] = {}

    ge_dir = output_dir / "generic-export"
    shard_dir = output_dir / "shards"

    def _get_shard(split: str) -> ShardWriter:
        if split not in shards:
            shards[split] = ShardWriter(shard_dir, split, args.shard_size)
        return shards[split]

    def _get_ge(split: str) -> GenericExportWriter:
        if split not in ge_writers:
            ge_writers[split] = GenericExportWriter(ge_dir, split)
        return ge_writers[split]

    # Build work queue
    work_queue: list[tuple] = []
    for row in iter_pdmx_csv(args.csv, args.mxl_root, limit=args.limit):
        sid = row["scoreId"]
        if args.resume and sid in done_ids:
            continue
        work_queue.append((
            sid,
            row["mxlPath"],
            row["composer"],
            row["title"],
            row["nTracks"],
            row["bars"],
            row["split"],
            str(output_dir),
            args.aug_n,
            args.dry_run,
        ))

    log.info("Work queue: %d scores (workers=%d)", len(work_queue), args.workers)

    # Stats
    ok_count = 0
    err_count = 0
    example_count = 0
    start_time = time.time()

    with (
        open(manifest_path, "a", encoding="utf-8") as manifest_fh,
        open(errors_path, "a", encoding="utf-8") as errors_fh,
        open(done_path, "a", encoding="utf-8") as done_fh,
    ):
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(process_score, w): w[0] for w in work_queue}

            for future in as_completed(futures):
                sid = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    err_count += 1
                    errors_fh.write(json.dumps(
                        {"scoreId": sid, "error": str(exc)}) + "\n")
                    errors_fh.flush()
                    continue

                if not result.get("ok"):
                    err_count += 1
                    errors_fh.write(json.dumps(result) + "\n")
                    errors_fh.flush()
                    continue

                ok_count += 1
                done_fh.write(sid + "\n")
                done_fh.flush()

                for ex in result.get("examples", []):
                    split = ex["split"]
                    crop_path = Path(ex["cropPath"])
                    kern_path = Path(ex["kernPath"])
                    if not crop_path.exists() or not kern_path.exists():
                        continue

                    kern_text = kern_path.read_text(encoding="utf-8")
                    crop_rel = str(crop_path.relative_to(output_dir))

                    # Write clean example
                    _get_shard(split).write(
                        ex["exampleId"], crop_path, kern_text,
                        {k: v for k, v in ex.items()
                         if k not in ("cropPath", "kernPath", "augPaths")},
                    )
                    if ex.get("measureStart") is not None:
                        _get_ge(split).write(
                            ex["exampleId"], crop_rel, kern_text,
                            ex["measureStart"], ex["measureEnd"],
                        )
                    example_count += 1

                    # Write augmented variants
                    for aug_i, aug_path_str in enumerate(ex.get("augPaths", [])):
                        aug_path = Path(aug_path_str)
                        if not aug_path.exists():
                            continue
                        aug_key = ex["exampleId"] + f"-aug{aug_i}"
                        aug_ex = dict(ex, exampleId=aug_key, augmented=True)
                        _get_shard(split).write(
                            aug_key, aug_path, kern_text,
                            {k: v for k, v in aug_ex.items()
                             if k not in ("cropPath", "kernPath", "augPaths")},
                        )
                        if ex.get("measureStart") is not None:
                            _get_ge(split).write(
                                aug_key,
                                str(aug_path.relative_to(output_dir)),
                                kern_text,
                                ex["measureStart"], ex["measureEnd"],
                            )
                        example_count += 1

                manifest_fh.write(json.dumps({
                    "scoreId": result["scoreId"],
                    "examples": len(result.get("examples", [])),
                }) + "\n")
                manifest_fh.flush()

                # Log progress every 100 scores
                if ok_count % 100 == 0:
                    elapsed = time.time() - start_time
                    rate = ok_count / elapsed
                    log.info(
                        "Progress: %d ok / %d err / %d examples | %.1f scores/s",
                        ok_count, err_count, example_count, rate,
                    )

    for w in shards.values():
        w.close()
    for w in ge_writers.values():
        w.close()

    elapsed = time.time() - start_time
    log.info(
        "Done in %.1fs — %d scores ok, %d errors, %d total examples",
        elapsed, ok_count, err_count, example_count,
    )

    # Write final manifest summary
    summary = {
        "ok": ok_count,
        "errors": err_count,
        "examples": example_count,
        "elapsed_s": round(elapsed, 1),
        "splits": {split: w.total for split, w in shards.items()},
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    log.info("Summary: %s", summary)


if __name__ == "__main__":
    main()
