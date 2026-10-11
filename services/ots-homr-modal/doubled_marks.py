"""Find slurs and ties that are drawn twice on the same notes.

Three patterns, all read the way a renderer reads them (slurs pair by number within a part, in time order):
  duplicate slur   two slur arcs with the same start event and the same stop event;
  slur over tie    a slur arc whose start and stop are the two notes of a tie (the pair is arced twice);
  duplicate tie    a note carrying two tie starts (or two tie stops) for the same pitch.
"""

import argparse
import collections
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "overlay"))

from markup_repair import _timed_events


def analyse(root):
    counts = collections.Counter()
    examples = []
    for part in root.findall("part"):
        events = _timed_events(part)
        open_slurs = {}
        arcs = []
        tie_pairs = set()
        open_ties = {}
        for index, (measure, onset, staff, notes) in enumerate(events):
            tie_starts = collections.Counter()
            tie_stops = collections.Counter()
            for note in notes:
                pitch = note.find("pitch")
                key = None if pitch is None else (pitch.findtext("step"), pitch.findtext("alter") or "0", pitch.findtext("octave"))
                for tie in note.findall("tie"):
                    if key is None:
                        continue
                    (tie_starts if tie.get("type") == "start" else tie_stops)[key] += 1
                for slur in note.iter("slur"):
                    number = slur.get("number") or "1"
                    if slur.get("type") == "start":
                        open_slurs[number] = (index, staff)
                    elif slur.get("type") == "stop" and number in open_slurs:
                        start_index, start_staff = open_slurs.pop(number)
                        arcs.append((start_index, index, start_staff))
            for key, n in tie_starts.items():
                if n > 1:
                    counts["duplicate tie"] += 1
                    examples.append(("duplicate tie", measure + 1))
                open_ties.setdefault(staff, {})[key] = index
            for key, n in tie_stops.items():
                if n > 1:
                    counts["duplicate tie"] += 1
                started = open_ties.get(staff, {}).pop(key, None)
                if started is not None:
                    tie_pairs.add((started, index))
        counts["slur arcs"] += len(arcs)
        counts["tie pairs"] += len(tie_pairs)
        seen = collections.Counter((a, b, s) for a, b, s in arcs)
        for (a, b, s), n in seen.items():
            if n > 1:
                counts["duplicate slur"] += n - 1
                examples.append(("duplicate slur", events[a][0] + 1))
        for a, b, s in set(arcs):
            if (a, b) in tie_pairs:
                counts["slur over tie"] += 1
                examples.append(("slur over tie", events[a][0] + 1))
    return counts, examples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    total = collections.Counter()
    for file in args.files:
        counts, examples = analyse(ET.parse(file).getroot())
        total.update(counts)
        if counts["duplicate slur"] or counts["slur over tie"] or counts["duplicate tie"]:
            print(file.name, {k: v for k, v in counts.items() if k in ("duplicate slur", "slur over tie", "duplicate tie")}, examples[:3])
    print("TOTAL", dict(total))


if __name__ == "__main__":
    main()
