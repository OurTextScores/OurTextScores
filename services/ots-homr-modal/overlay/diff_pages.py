"""Note-level differences between two readings of one page, mapped onto the rendered SVGs.

Both MusicXML files are first normalised through MuseScore (so beams, ties and slurs are encoded alike). Events are
keyed by (measure, staff, onset). A key differs when its notes or rests differ ("notes"), its first-level beaming
differs ("beam"), or its ties/slurs differ ("marks"). Each difference is placed on the rendered page by matching
the measure's distinct onsets to the x-clusters of noteheads inside its measure box, and the staff to the nearest
band of staff lines. Where the counts do not match, the whole measure is flagged instead and counted as a fallback.
"""

import json
import xml.etree.ElementTree as ET
from collections import defaultdict
from fractions import Fraction


def parse_events(path):
    root = ET.parse(path).getroot()
    events = defaultdict(lambda: {"notes": [], "rests": [], "beam": [], "tie": set(), "slur": set(), "lyric": set(), "direction": set()})
    onsets = defaultdict(set)  # measure -> onsets that carry at least one pitched note
    staff_base, staff_total = {}, 0
    measures = 0
    for part_index, part in enumerate(root.findall("part")):
        staves = 1
        first = part.find("measure/attributes/staves")
        if first is not None and first.text:
            staves = int(first.text)
        staff_base[part_index] = staff_total
        staff_total += staves
        divisions = 1
        for m_index, measure in enumerate(part.findall("measure")):
            measures = max(measures, m_index + 1)
            cursor, previous = Fraction(0), Fraction(0)
            for element in measure:
                if element.tag == "attributes" and element.findtext("divisions"):
                    divisions = int(element.findtext("divisions"))
                elif element.tag == "backup":
                    cursor -= Fraction(int(element.findtext("duration") or 0), divisions)
                elif element.tag == "forward":
                    cursor += Fraction(int(element.findtext("duration") or 0), divisions)
                elif element.tag == "direction":
                    staff = staff_base[part_index] + int(element.findtext("staff") or 1) - 1
                    words = [w.text.strip() for w in element.iter("words") if (w.text or "").strip()]
                    marks = [child.tag for d in element.iter("dynamics") for child in d]
                    if words or marks:
                        events[(m_index, staff, str(cursor))]["direction"].update(words + marks)
                elif element.tag == "note":
                    chord = element.find("chord") is not None
                    onset = previous if chord else cursor
                    duration = Fraction(int(element.findtext("duration") or 0), divisions)
                    staff = staff_base[part_index] + int(element.findtext("staff") or 1) - 1
                    event = events[(m_index, staff, str(onset))]
                    pitch = element.find("pitch")
                    if element.find("grace") is not None:
                        pass
                    elif pitch is None:
                        event["rests"].append(str(duration))
                        event["restcount"] = event.get("restcount", 0) + 1
                    else:
                        alter = float(pitch.findtext("alter") or 0)
                        event["notes"].append(f"{pitch.findtext('step')}{alter:+g}{pitch.findtext('octave')}:{duration}")
                        event["heads"] = event.get("heads", 0) + (0 if element.find("grace") is not None else 1)
                        onsets[m_index].add(str(onset))
                        first_beam = [b.text for b in element.findall("beam") if b.get("number") == "1"]
                        event["beam"].append(first_beam[0] if first_beam else "-")
                    for lyric in element.findall("lyric"):
                        text = "".join(t.text or "" for t in lyric.findall("text"))
                        if text:
                            event["lyric"].add(f"{lyric.get('number') or '1'}:{text}")
                    for tie in element.findall("tie"):
                        event["tie"].add(tie.get("type"))
                    for slur in element.iter("slur"):
                        event["slur"].add(slur.get("type"))
                    if not chord:
                        previous = onset
                        cursor += duration
    return {"events": events, "onsets": {m: sorted(o, key=Fraction) for m, o in onsets.items()}, "staves": staff_total, "measures": measures}


def signature(event):
    return (sorted(event["notes"]), sorted(event["rests"]))


def by_staff(side):
    grouped = defaultdict(list)
    for (measure, staff, onset), event in side["events"].items():
        grouped[(measure, staff)].append((Fraction(onset), onset, event))
    return {k: sorted(v, key=lambda e: e[0]) for k, v in grouped.items()}


def diff(left, right, mode="engines", beams=True):
    """Differences per side, each keyed by that side's own (measure, staff, onset) -> kind.

    Within every (measure, staff) the two event sequences are aligned with difflib, so one wrong duration flags
    the events that differ and not every later onset. mode "review" compares only the lyrics and directions an
    event carries (a reviewed copy against its scan), keyed by onset."""
    import difflib

    left_diffs, right_diffs = {}, {}
    if mode == "review":
        for key in set(left["events"]) | set(right["events"]):
            a = left["events"].get(key) or {"lyric": set(), "direction": set()}
            b = right["events"].get(key) or {"lyric": set(), "direction": set()}
            kind = "lyric" if a["lyric"] != b["lyric"] else "direction" if a["direction"] != b["direction"] else None
            if kind:
                if key in left["events"]:
                    left_diffs[key] = kind
                if key in right["events"]:
                    right_diffs[key] = kind
        return left_diffs, right_diffs
    lg, rg = by_staff(left), by_staff(right)
    for group in set(lg) | set(rg):
        a, b = lg.get(group, []), rg.get(group, [])
        sig_a = [json.dumps(signature(e[2])) for e in a]
        sig_b = [json.dumps(signature(e[2])) for e in b]
        matcher = difflib.SequenceMatcher(None, sig_a, sig_b, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                for x, y in zip(a[i1:i2], b[j1:j2]):
                    ea, eb = x[2], y[2]
                    kind = "beam" if beams and sorted(ea["beam"]) != sorted(eb["beam"]) else "marks" if ea["tie"] != eb["tie"] or ea["slur"] != eb["slur"] else None
                    if kind:
                        left_diffs[(group[0], group[1], x[1])] = kind
                        right_diffs[(group[0], group[1], y[1])] = kind
            else:
                for x in a[i1:i2]:
                    left_diffs[(group[0], group[1], x[1])] = "notes"
                for y in b[j1:j2]:
                    right_diffs[(group[0], group[1], y[1])] = "notes"
    return left_diffs, right_diffs


def bands(layout, rect):
    """Staff bands (top, bottom) of the system a measure box belongs to, ordered top to bottom."""
    ys = sorted({round(l["y"], 1) for l in layout["lines"] if l["x1"] <= rect["x"] + rect["sx"] and l["x2"] >= rect["x"] and rect["y"] - 5 <= l["y"] <= rect["y"] + rect["sy"] + 5})
    groups = []
    for y in ys:
        if groups and y - groups[-1][-1] < 60:
            groups[-1].append(y)
        else:
            groups.append([y])
    return [(g[0], g[-1]) for g in groups]


def place(side, layout, differences):
    """Highlight boxes (SVG units) for one side, plus per-measure fallbacks.

    Per measure and staff band the rendered noteheads, sorted left to right, are dealt out to that staff's pitched
    events in onset order (an event takes as many heads as it has notes). When the head count of a band does not
    equal the note count of its staff, the measure is flagged whole instead."""
    boxes, fallbacks, mapped, total = [], [], 0, 0
    weak_seen = set()
    by_measure = defaultdict(list)
    for (measure, staff, onset), kind in differences.items():
        by_measure[measure].append((staff, onset, kind))
    for measure, items in by_measure.items():
        if measure >= len(layout["measures"]):
            continue
        rect = layout["measures"][measure]
        staff_bands = bands(layout, rect)
        heads = [h for h in layout["heads"] + layout.get("rests", []) if rect["x"] - 25 <= h["x"] <= rect["x"] + rect["sx"] and rect["y"] - 60 <= h["y"] <= rect["y"] + rect["sy"] + 60]
        usable = len(staff_bands) == side["staves"]
        per_band = defaultdict(list)
        if usable:
            centers = [(t + b) / 2 for t, b in staff_bands]
            for head in heads:
                per_band[min(range(len(centers)), key=lambda i: abs(centers[i] - head["y"]))].append(head)
        # events of each staff in this measure, in onset order
        from fractions import Fraction

        layout_events = defaultdict(list)
        for (m, st, onset), event in side["events"].items():
            if m == measure and (event.get("heads") or event.get("restcount")):
                layout_events[st].append((Fraction(onset), onset, event.get("heads", 0) + event.get("restcount", 0)))
        dealt = {}
        for staff, evs in layout_events.items():
            evs.sort()
            band_heads = sorted(per_band.get(staff, []), key=lambda h: (h["x"], h["y"]))
            if usable and len(band_heads) == sum(n for _, _, n in evs):
                i = 0
                for _, onset, n in evs:
                    dealt[(staff, onset)] = band_heads[i : i + n]
                    i += n
        for staff, onset, kind in items:
            total += 1
            group = dealt.get((staff, onset))
            if group:
                x0, x1 = min(h["x"] for h in group) - 14, max(h["x"] for h in group) + 52
                top, bottom = staff_bands[staff]
                boxes.append({"x": x0, "y": top - 30, "w": x1 - x0, "h": bottom - top + 60, "kind": kind, "measure": measure})
                mapped += 1
            elif usable and staff < len(staff_bands):
                if (measure, staff) in weak_seen:
                    mapped += 1
                    continue
                weak_seen.add((measure, staff))
                top, bottom = staff_bands[staff]  # this staff's symbols could not be matched one by one: outline it once
                boxes.append({"x": rect["x"], "y": top - 20, "w": rect["sx"], "h": bottom - top + 40, "kind": kind, "measure": measure, "weak": True})
                mapped += 1
            else:
                fallbacks.append({"x": rect["x"], "y": rect["y"], "w": rect["sx"], "h": rect["sy"], "measure": measure, "kind": kind})
    seen, unique = set(), []
    for f in fallbacks:
        if f["measure"] not in seen:
            seen.add(f["measure"])
            unique.append(f)
    return {"boxes": boxes, "fallbackMeasures": unique, "differences": total, "mapped": mapped}


def compare(left_xml, right_xml, left_layout, right_layout, mode="engines", beams=True):
    left, right = parse_events(left_xml), parse_events(right_xml)
    left_diffs, right_diffs = diff(left, right, mode, beams)
    counts = defaultdict(int)
    for kind in right_diffs.values():
        counts[kind] += 1
    return {
        "counts": dict(counts),
        "countsLeft": {k: sum(1 for v in left_diffs.values() if v == k) for k in set(left_diffs.values())},
        "measures": [left["measures"], right["measures"]],
        "left": place(left, left_layout, left_diffs),
        "right": place(right, right_layout, right_diffs),
    }


if __name__ == "__main__":
    import sys

    a, b, la, lb = sys.argv[1:5]
    print(json.dumps(compare(a, b, json.load(open(la)), json.load(open(lb))), indent=1)[:1500])
