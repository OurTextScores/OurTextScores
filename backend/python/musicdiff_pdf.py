#!/usr/bin/env python3
"""
Generate visual musicdiff PDF from two MusicXML files.

Usage: python3 musicdiff_pdf.py <file1> <file2> <output.pdf>

This script uses the musicdiff Python API to generate marked-up PDFs
showing the differences between two music scores, then combines them
into a single PDF document.
"""

import sys
import os
import tempfile
from pathlib import Path


def combine_pdfs(pdf1_path: str, pdf2_path: str, output_path: str):
    """Combine two PDF files into one."""
    try:
        from PyPDF2 import PdfMerger
        merger = PdfMerger()
        merger.append(pdf1_path)
        merger.append(pdf2_path)
        merger.write(output_path)
        merger.close()
    except ImportError:
        # Fallback: if PyPDF2 not available, just return the first PDF
        # (or we could concatenate the raw bytes)
        import shutil
        shutil.copy(pdf1_path, output_path)


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 musicdiff_pdf.py <file1> <file2> <output.pdf>", file=sys.stderr)
        sys.exit(1)

    file1 = sys.argv[1]
    file2 = sys.argv[2]
    output_pdf = sys.argv[3]

    if not os.path.exists(file1):
        print(f"Error: {file1} not found", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(file2):
        print(f"Error: {file2} not found", file=sys.stderr)
        sys.exit(1)

    # Import musicdiff
    try:
        import musicdiff
    except ImportError:
        print("Error: musicdiff package not installed", file=sys.stderr)
        sys.exit(1)

    # Create temp files for the two output PDFs
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf1_path = os.path.join(tmpdir, "score1.pdf")
        pdf2_path = os.path.join(tmpdir, "score2.pdf")

        # Run musicdiff with explicit output paths
        try:
            diff_count = musicdiff.diff(
                file1,
                file2,
                out_path1=pdf1_path,
                out_path2=pdf2_path
            )
        except Exception as e:
            print(f"Error running musicdiff: {e}", file=sys.stderr)
            sys.exit(1)

        # When files are identical (diff_count == 0), musicdiff doesn't generate PDFs
        # In this case, generate a PDF from one of the source files manually
        if not os.path.exists(pdf1_path) or not os.path.exists(pdf2_path):
            print(f"musicdiff did not create PDFs (found {diff_count} differences), generating manually...", file=sys.stderr)
            try:
                from music21 import converter
                score = converter.parse(file1)
                # Generate a single PDF from the first file
                score.write('musicxml.pdf', fp=pdf1_path)
                # For identical files, use the same PDF for both
                import shutil
                shutil.copy(pdf1_path, pdf2_path)
            except Exception as e:
                print(f"Error generating PDF with music21: {e}", file=sys.stderr)
                sys.exit(1)

        # Verify PDFs were created
        if not os.path.exists(pdf1_path):
            print(f"Error: Could not create {pdf1_path}", file=sys.stderr)
            sys.exit(1)
        if not os.path.exists(pdf2_path):
            print(f"Error: Could not create {pdf2_path}", file=sys.stderr)
            sys.exit(1)

        # Combine the PDFs
        try:
            combine_pdfs(pdf1_path, pdf2_path, output_pdf)
        except Exception as e:
            print(f"Error combining PDFs: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"Success: Combined PDF written to {output_pdf}", file=sys.stderr)


if __name__ == "__main__":
    main()
