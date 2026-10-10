"""Make the beam and tremolo markup of a page MusicXML structurally valid.

OTS-HOMR writes each note's predicted beam state straight into the file (`build_beams` in the pinned source). The
model predicts every note on its own, so a noisy prediction becomes markup MuseScore cannot interpret: a beam on a rest
or on a quarter or longer note, a `begin` that never gets an `end`, an `end` with no `begin`. An unclosed `begin`
makes MuseScore stretch one beam across the page.

Beams are removed from rests and from notes longer than an eighth, which cannot carry one. Optionally
(`beam_groups=True`, off by default) a group (begin, continue*, end) is kept only if it is closed inside the measure,
has at least two notes and its higher levels are well formed, and every other beamed note loses its beams so the editor
beams it by default. Measured on held-out pages that group pass lowers agreement with the printed beaming (51.6% against
68.4% for the file as written), because MuseScore reads the model's own groups better than it beams by default, so
the provider leaves it off. It never invents a beam and never moves one.

Paired tremolos (`<tremolo type="start">` ... `<tremolo type="stop">`) draw one slanted bar between two notes, so a
pair is kept only when both marks sit on consecutive notes of the same voice in the same measure. A `start` whose
`stop` is in another measure, never comes, or comes with no `start` makes MuseScore draw one enormous slanted bar
across the page, so every mark of such a pair is removed. HOMR itself writes such pairs, so this applies to both
engines' output.

Slurs are paired per staff in time order (OTS-HOMR and HOMR number slurs per staff, so a piano's two staves collide
when numbers are read the MusicXML way). A `stop` with no open `start`, a `start` overwritten or never closed, and a pair
spanning more than MAX_SLUR_MEASURES measures are removed; the remaining pairs are renumbered so no two overlapping
slurs of a part share a number.
"""

import xml.etree.ElementTree as ET
from collections import Counter
from fractions import Fraction

MAX_SLUR_MEASURES = 4
BEAMABLE = {"eighth", "16th", "32nd", "64th", "128th", "256th"}


def _events(measure):
    """Notes of a measure as events: the first note of a chord with its chord tones, per (staff, voice)."""
    voices = {}
    for note in measure.findall("note"):
        key = (note.findtext("staff") or "1", note.findtext("voice") or "1")
        events = voices.setdefault(key, [])
        if note.find("chord") is not None and events:
            events[-1].append(note)
        else:
            events.append([note])
    return voices


def _beam_states(note):
    return {int(b.get("number") or 1): b.text for b in note.findall("beam")}


def _strip(event):
    for note in event:
        for beam in note.findall("beam"):
            note.remove(beam)


def _levels_well_formed(group):
    """Higher levels inside a closed level-1 group: each level reads begin, continue*, end or is a lone hook."""
    levels = sorted({lvl for event in group for lvl in _beam_states(event[0]) if lvl > 1})
    for level in levels:
        open_ = False
        for event in group:
            state = _beam_states(event[0]).get(level)
            if state == "begin":
                if open_:
                    return False
                open_ = True
            elif state == "continue":
                if not open_:
                    return False
            elif state == "end":
                if not open_:
                    return False
                open_ = False
            elif state in ("forward hook", "backward hook"):
                if open_:
                    return False
            elif state is None:
                if open_:
                    return False
        if open_:
            return False
    return True


def repair_measure(measure, stats, groups=False):
    for events in _events(measure).values():
        # 1. beams cannot sit on rests or on notes longer than an eighth
        for event in events:
            first = event[0]
            if not _beam_states(first):
                continue
            if first.find("rest") is not None or first.findtext("type") not in BEAMABLE:
                _strip(event)
                stats["removed from rest or long note"] += 1
        if not groups:
            continue
        # 2. keep only closed, well-formed level-1 groups
        beamed = [e for e in events if _beam_states(e[0])]
        group, keep = None, set()
        for event in events:
            state = _beam_states(event[0]).get(1)
            if state == "begin":
                group = [event]
            elif state == "continue" and group is not None:
                group.append(event)
            elif state == "end" and group is not None:
                group.append(event)
                if len(group) >= 2 and _levels_well_formed(group):
                    keep.update(id(e) for e in group)
                group = None
            elif event[0].find("rest") is None and state is not None:
                group = None  # a stray level-1 state (hook or orphan) ends any open group
            elif event[0].find("rest") is None and state is None:
                group = None
        for event in beamed:
            if id(event) not in keep:
                _strip(event)
                stats["beams dropped (group invalid)"] += 1
            else:
                stats["beams kept"] += 1


def _remove_tremolo(note):
    for notations in note.findall("notations"):
        for ornaments in notations.findall("ornaments"):
            for tremolo in ornaments.findall("tremolo"):
                ornaments.remove(tremolo)
            if len(ornaments) == 0:
                notations.remove(ornaments)
        if len(notations) == 0:
            note.remove(notations)


def repair_tremolos(part, stats):
    """Drop every tremolo mark of a start/stop pair that is not two consecutive notes of one voice in one measure."""
    sequences = {}
    for m_index, measure in enumerate(part.findall("measure")):
        for key, events in _events(measure).items():
            sequences.setdefault(key, []).extend((m_index, i, event) for i, event in enumerate(events))
    for events in sequences.values():
        open_ = None  # (measure, index, event)
        for m_index, i, event in events:
            marks = [t.get("type") for note in event[:1] for t in note.iter("tremolo")]
            if "start" in marks:
                if open_ is not None:
                    for note in open_[2]:
                        _remove_tremolo(note)
                    stats["tremolo pairs removed"] += 1
                open_ = (m_index, i, event)
            if "stop" in marks:
                if open_ is not None and open_[0] == m_index and open_[1] == i - 1 and "start" not in marks:
                    stats["tremolo pairs kept"] += 1
                else:
                    for note in event:
                        _remove_tremolo(note)
                    if open_ is not None:
                        for note in open_[2]:
                            _remove_tremolo(note)
                    stats["tremolo pairs removed"] += 1
                open_ = None
        if open_ is not None:
            for note in open_[2]:
                _remove_tremolo(note)
            stats["tremolo pairs removed"] += 1


def _timed_events(part):
    """(measure, onset, staff, [notes of one chord]) for every non-grace note event of a part, in time order."""
    events = []
    for m_index, measure in enumerate(part.findall("measure")):
        divisions = 1
        cursor = previous = Fraction(0)
        for element in measure:
            if element.tag == "attributes" and element.findtext("divisions"):
                divisions = int(element.findtext("divisions"))
            elif element.tag == "backup":
                cursor -= Fraction(int(element.findtext("duration") or 0), divisions)
            elif element.tag == "forward":
                cursor += Fraction(int(element.findtext("duration") or 0), divisions)
            elif element.tag == "note":
                chord = element.find("chord") is not None
                onset = previous if chord else cursor
                if chord and events and events[-1][0] == m_index and events[-1][1] == onset:
                    events[-1][3].append(element)
                else:
                    events.append((m_index, onset, element.findtext("staff") or "1", [element]))
                if not chord:
                    previous = onset
                    cursor += Fraction(int(element.findtext("duration") or 0), divisions)
    events.sort(key=lambda e: (e[0], e[1]))
    return events


def _slur_elements(event, kind):
    return [slur for note in event for slur in note.iter("slur") if slur.get("type") == kind]


def _remove_slurs(event, kind=None):
    for note in event:
        for notations in note.findall("notations"):
            for slur in list(notations.findall("slur")):
                if kind is None or slur.get("type") == kind:
                    notations.remove(slur)
            if len(notations) == 0:
                note.remove(notations)


def repair_slurs(part, stats):
    """Pair slurs per staff in time order; drop orphans and overlong spans; renumber the survivors."""
    events = _timed_events(part)
    open_by_staff = {}
    pairs = []  # (start index, stop index) into `events`
    for index, (m_index, onset, staff, notes) in enumerate(events):
        stops = _slur_elements(notes, "stop")
        starts = _slur_elements(notes, "start")
        if stops:
            if staff in open_by_staff:
                pairs.append((open_by_staff.pop(staff), index))
            else:
                _remove_slurs(notes, "stop")
                stats["slur stops removed (no start)"] += 1
        if starts:
            if staff in open_by_staff:
                _remove_slurs(events[open_by_staff[staff]][3], "start")
                stats["slur starts removed (overwritten)"] += 1
            open_by_staff[staff] = index
    for staff, index in open_by_staff.items():
        _remove_slurs(events[index][3], "start")
        stats["slur starts removed (never closed)"] += 1
    kept = []
    for a, b in pairs:
        if events[b][0] - events[a][0] > MAX_SLUR_MEASURES:
            _remove_slurs(events[a][3], "start")
            _remove_slurs(events[b][3], "stop")
            stats["slurs removed (span too long)"] += 1
        else:
            kept.append((a, b))
    kept.sort()
    active = []  # (stop index, number)
    for a, b in kept:
        active = [(stop, num) for stop, num in active if stop >= a]
        used = {num for _, num in active}
        number = next(n for n in range(1, 99) if n not in used)
        active.append((b, number))
        for slur in _slur_elements(events[a][3], "start") + _slur_elements(events[b][3], "stop"):
            slur.set("number", str(number))
        stats["slurs kept"] += 1


def repair_musicxml(data: bytes, beam_groups=False):
    """Return (repaired MusicXML bytes, Counter of what was done). `beam_groups=True` also drops every beam group that is not closed and well formed; it is off by default because
    MuseScore reads the model's own groups better than it beams the dropped notes itself (see beam_fair.py)."""
    stats = Counter()
    tree = ET.ElementTree(ET.fromstring(data))
    for part in tree.getroot().iter("part"):
        for measure in part.findall("measure"):
            repair_measure(measure, stats, beam_groups)
        repair_tremolos(part, stats)
        repair_slurs(part, stats)
    out = ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True)
    return out, stats
