#!/usr/bin/env python3
"""
p0-align.py — Stage 4: Kern alignment → system-grain kern excerpts.

Reads p0-segment-manifest.jsonl (written by p0-segment.mjs). For each score:
  1. Loads the full canonical kern from kern/<scoreId>.kern
  2. Parses the MXL for <print new-system/new-page> markers → measure ranges per system
  3. Slices kern for each system listed in the layout JSON
  4. Writes <scoreId>-p<N>-s<M>.kern alongside the crop PNG
  5. Back-fills measureRange into the layout JSON

Usage:
    python3 scripts/p0-align.py \
        --segment-manifest ./data/p0/p0-segment-manifest.jsonl \
        --kern-dir         ./data/p0/kern \
        --crops-dir        ./data/p0/crops \
        --mxl-root         /mnt/bakery/jhlusko/pdmx_dataset \
        --output           ./data/p0 \
        [--workers 8] [--resume] [--limit 100] [--dry-run]
"""

import argparse
import io
import json
import logging
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "Transcribe the music notation in this image to canonical **kern. "
    "Output only the **kern text, nothing else."
)

# ===========================================================================
# MXL → system measure ranges  (identical to p0_pipeline.py Stage 4)
# ===========================================================================

def get_system_measure_ranges(mxl_path: str) -> list[tuple[int, int]]:
    """
    Parse <print new-system="yes"|new-page="yes"> markers from MusicXML.
    Returns [(start, end), …] one tuple per system across all pages.
    """
    path = Path(mxl_path)
    try:
        if path.suffix.lower() == ".mxl":
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


# ===========================================================================
# Kern slicing  (identical to p0_pipeline.py Stage 4)
# ===========================================================================

def slice_kern_measures(kern_text: str, start: int, end: int) -> str:
    """Extract measures start..end (inclusive) from full-score kern."""
    lines = kern_text.split("\n")

    spine_lines = [l for l in lines if l.startswith("**")]
    current_clef: list[str] = []
    current_key: list[str] = []
    current_time: list[str] = []
    in_range = False
    body: list[str] = []

    for line in lines:
        stripped = line.strip()

        if re.match(r'\*clef', stripped):
            current_clef = [line]
        if re.match(r'\*k\[', stripped, re.IGNORECASE):
            current_key = [line]
        if re.match(r'\*M\d', stripped):
            current_time = [line]

        bar_m = re.match(r'^(=+)(\d+)', stripped)
        if bar_m:
            m_num = int(bar_m.group(2))
            if m_num == start:
                in_range = True
            elif m_num > end:
                in_range = False

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


# ===========================================================================
# Per-score worker
# ===========================================================================

def align_score(args: tuple) -> dict:
    (score_id, mxl_path, split, layout_path, kern_path, crops_dir, dry_run) = args

    layout_path = Path(layout_path)
    kern_path = Path(kern_path)
    crops_dir = Path(crops_dir)

    # Load full-score kern
    if not kern_path.exists():
        return {"scoreId": score_id, "ok": False, "reason": "kern_missing"}
    try:
        kern_text = kern_path.read_text(encoding="utf-8")
    except Exception as e:
        return {"scoreId": score_id, "ok": False, "reason": f"kern_read_error: {e}"}

    # Load layout JSON
    try:
        layout = json.loads(layout_path.read_text())
    except Exception as e:
        return {"scoreId": score_id, "ok": False, "reason": f"layout_read_error: {e}"}

    # Get system measure ranges from MXL
    system_ranges = get_system_measure_ranges(mxl_path)
    if not system_ranges:
        return {"scoreId": score_id, "ok": False, "reason": "no_measure_ranges"}

    if dry_run:
        return {"scoreId": score_id, "ok": True, "dry_run": True, "written": 0}

    score_crops_dir = crops_dir / split
    written = 0
    system_cursor = 0

    for page in layout.get("pages", []):
        if not page.get("hasMusicContent"):
            continue
        for system in page.get("systems", []):
            if system_cursor >= len(system_ranges):
                break
            m_start, m_end = system_ranges[system_cursor]
            system_cursor += 1

            # Back-fill measureRange into layout (written at end)
            system["measureRange"] = [m_start, m_end]

            # Derive crop name from cropPath: "crops/train/<name>.png" → "<name>"
            crop_path_str = system.get("cropPath", "")
            crop_name = Path(crop_path_str).stem  # e.g. "4695369-p01-s00"

            kern_out = score_crops_dir / f"{crop_name}.kern"
            if not kern_out.exists():
                excerpt = slice_kern_measures(kern_text, m_start, m_end)
                kern_out.write_text(excerpt, encoding="utf-8")
                written += 1

    # Rewrite layout JSON with measureRange filled in
    layout_path.write_text(json.dumps(layout, indent=2), encoding="utf-8")

    return {"scoreId": score_id, "ok": True, "written": written}


# ===========================================================================
# Main
# ===========================================================================

def main():
    parser = argparse.ArgumentParser(description="P0 Stage 4: kern alignment")
    parser.add_argument("--segment-manifest", required=True,
                        help="p0-segment-manifest.jsonl from p0-segment.mjs")
    parser.add_argument("--kern-dir", required=True,
                        help="Directory containing <scoreId>.kern files")
    parser.add_argument("--crops-dir", required=True,
                        help="Directory containing crops/<split>/ subdirs")
    parser.add_argument("--mxl-root", default="",
                        help="Prepend to relative mxlPath values")
    parser.add_argument("--output", default="./data/p0",
                        help="Output directory for done/errors files")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    done_path   = output_dir / "p0-align-done.txt"
    errors_path = output_dir / "p0-align-errors.jsonl"

    done_ids: set[str] = set()
    if args.resume and done_path.exists():
        done_ids = set(done_path.read_text().splitlines())
        log.info("Resuming — %d scores already aligned", len(done_ids))

    # Read segment manifest
    rows = []
    with open(args.segment_manifest) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    log.info("Loaded %d entries from segment manifest", len(rows))

    kern_dir  = Path(args.kern_dir)
    crops_dir = Path(args.crops_dir)

    work = []
    for row in rows:
        score_id    = row["scoreId"]
        split       = row.get("split", "train")
        layout_path = row.get("layoutPath", "")
        mxl_path    = ""  # not in segment manifest — derive from kern or skip

        if args.resume and score_id in done_ids:
            continue
        if not layout_path or not Path(layout_path).exists():
            continue

        kern_path = kern_dir / f"{score_id}.kern"
        if not kern_path.exists():
            continue  # kern not yet produced by pipeline — skip for now

        # mxlPath lives in the layout JSON (written by p0-segment.mjs)
        try:
            layout = json.loads(Path(layout_path).read_text())
        except Exception:
            continue

        mxl_path = layout.get("mxlPath", "")
        if not mxl_path:
            continue

        if args.mxl_root and not mxl_path.startswith("/"):
            mxl_path = str(Path(args.mxl_root) / mxl_path)

        if args.limit and len(work) >= args.limit:
            break

        work.append((score_id, mxl_path, split, layout_path, str(kern_path),
                     str(crops_dir), args.dry_run))

    log.info("Work queue: %d scores (workers=%d)", len(work), args.workers)

    ok = err = 0
    start_time = __import__("time").time()

    with open(done_path, "a") as done_fh, open(errors_path, "a") as err_fh:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(align_score, item): item[0] for item in work}
            for i, fut in enumerate(as_completed(futures), 1):
                result = fut.result()
                if result.get("ok"):
                    ok += 1
                    if not result.get("dry_run"):
                        done_fh.write(result["scoreId"] + "\n")
                else:
                    err += 1
                    err_fh.write(json.dumps(result) + "\n")

                if i % 200 == 0:
                    elapsed = __import__("time").time() - start_time
                    log.info("Progress: %d ok / %d err | %.1f scores/s",
                             ok, err, i / elapsed)

    elapsed = __import__("time").time() - start_time
    log.info("Done: %d ok / %d err in %.0fs", ok, err, elapsed)


if __name__ == "__main__":
    main()
