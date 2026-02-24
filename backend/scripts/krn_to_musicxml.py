#!/usr/bin/env python3
"""Convert Humdrum/Kern (.krn) files to plain MusicXML (.xml).

CLI contract matches DerivativePipelineService:
  krn2musicxml <input.krn> <output.xml>
"""

from __future__ import annotations

import os
import sys


def _print_version() -> int:
    try:
        import music21  # type: ignore

        print(f"krn2musicxml (music21 {getattr(music21, '__version__', 'unknown')})")
        return 0
    except Exception as exc:  # pragma: no cover - best effort version output
        print(f"krn2musicxml (music21 unavailable: {exc})")
        return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] in {"--version", "-V", "-v"}:
        return _print_version()

    if len(argv) != 3:
        print("Usage: krn2musicxml <input.krn> <output.xml>", file=sys.stderr)
        return 2

    in_path, out_path = argv[1], argv[2]

    try:
        from music21 import converter  # type: ignore
    except Exception as exc:
        print(f"Failed to import music21: {exc}", file=sys.stderr)
        return 1

    try:
        # Prefer explicit Humdrum parser; fallback to auto-detection.
        try:
            score = converter.parse(in_path, format="humdrum")
        except Exception:
            score = converter.parse(in_path)

        out_dir = os.path.dirname(os.path.abspath(out_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)

        score.write("musicxml", fp=out_path)
        return 0
    except Exception as exc:
        print(f"Kern conversion failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
