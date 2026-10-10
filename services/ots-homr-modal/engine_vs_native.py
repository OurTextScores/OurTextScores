"""Score two engines' page MusicXML against the native OpenScore source: best per-measure pitch similarity.

For each page, every recognised part is aligned to every part of every native source filed under the page's IMSLP id;
the page score is the best mean per-measure pitch similarity (SequenceMatcher on note pitches, 1.0 = identical; a token is wrong if either pitch or duration differs).
Tokens are pitch (step, alter, octave) with duration, and rests; chord tones beyond the first, beams, ties, text and
markings are ignored, so it is a coarse, symmetric yardstick for comparing two readings of one page, not a transcription accuracy.
"""

import argparse
import json
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from score_direction_placement import SOURCES, align, fetch, native_candidates, parse_parts


def _alter(pitch):
    """Semitone alteration as a number, so an explicit <alter>0</alter> equals no <alter> at all."""
    value = float(pitch.findtext("alter") or 0)
    return "" if value == 0 else f"{value:+g}"


def parse_rhythm_parts(root):
    """parts -> measures -> {"pitches": [pitch:duration or R:duration tokens]} (duration in quarter notes)."""
    parts = []
    for part in root.iter("part"):
        divisions, measures = 1, []
        for measure in part.findall("measure"):
            tokens = []
            for element in measure:
                if element.tag == "attributes" and element.findtext("divisions"):
                    divisions = float(element.findtext("divisions"))
                elif element.tag == "note":
                    if element.find("chord") is not None:
                        continue
                    duration = round(float(element.findtext("duration") or 0) / divisions, 3)
                    pitch = element.find("pitch")
                    name = "R" if pitch is None else f"{pitch.findtext('step')}{_alter(pitch)}{pitch.findtext('octave')}"
                    tokens.append(f"{name}:{duration}")
            if len(tokens) == 1 and tokens[0].startswith("R:"):
                tokens = ["R:full"]  # a lone rest is a whole-measure rest whatever duration the engine wrote
            measures.append({"pitches": tokens})
        parts.append(measures)
    return parts


def page_score(root, candidates, parser=parse_rhythm_parts):
    parts = [p for p in parser(root) if p]
    best = 0.0
    for _, native_root in candidates:
        for native in parser(native_root):
            for part in parts:
                if native and len(native) >= 1:
                    best = max(best, align(part, native)[1])
    return best, [len(p) for p in parts]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    rows = []
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        score = Path(job["image"]).parent.name
        name = Path(job["image"]).stem
        candidates = list(native_candidates(score, catalogue))
        ours = ET.fromstring(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token))
        ours_score, ours_parts = page_score(ours, candidates)
        upstream_file = args.upstream / f"{name}.musicxml"
        if upstream_file.exists():
            upstream_score, upstream_parts = page_score(ET.parse(upstream_file).getroot(), candidates)
        else:
            upstream_score, upstream_parts = None, None
        rows.append({"page": name, "score": score, "ours": round(ours_score, 4), "upstream": None if upstream_score is None else round(upstream_score, 4), "oursMeasures": ours_parts, "upstreamMeasures": upstream_parts})
    both = [r for r in rows if r["upstream"] is not None]
    summary = {
        "pages": len(rows),
        "bothRead": len(both),
        "upstreamFailed": [r["page"] for r in rows if r["upstream"] is None],
        "meanOurs": round(statistics.mean(r["ours"] for r in both), 4),
        "meanUpstream": round(statistics.mean(r["upstream"] for r in both), 4),
        "oursBetter": sum(r["ours"] > r["upstream"] + 0.02 for r in both),
        "upstreamBetter": sum(r["upstream"] > r["ours"] + 0.02 for r in both),
        "within0.02": sum(abs(r["ours"] - r["upstream"]) <= 0.02 for r in both),
    }
    args.out.write_text(json.dumps({"summary": summary, "pages": rows}, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
