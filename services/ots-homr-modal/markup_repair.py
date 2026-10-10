"""Make the beam and tremolo markup of a page MusicXML structurally valid.

OTS-HOMR writes each note's predicted beam state straight into the file (`build_beams` in the pinned source). The
model predicts every note on its own, so a noisy prediction becomes markup MuseScore cannot interpret: a beam on a rest
or on a quarter or longer note, a `begin` that never gets an `end`, an `end` with no `begin`. An unclosed `begin`
makes MuseScore stretch one beam across the page.

The repair works per voice and measure on the first beam level, which defines the groups:
  * beams are removed from rests and from notes longer than an eighth;
  * a group (begin, continue*, end) is kept only if it is closed inside the measure, has at least two notes, and every
    higher beam level inside it is itself well formed (begin/continue/end runs, or a single hook on a lone note);
  * every other beamed note loses all its beams, so the editor beams it by its own default (absence is how MusicXML
    says "beam this automatically").
It never invents a beam and never moves one.

Paired tremolos (`<tremolo type="start">` ... `<tremolo type="stop">`) draw one slanted bar between two notes, so a
pair is kept only when both marks sit on consecutive notes of the same voice in the same measure. A `start` whose
`stop` is in another measure, never comes, or comes with no `start` makes MuseScore draw one enormous slanted bar
across the page, so every mark of such a pair is removed. HOMR itself writes such pairs, so this applies to both
engines' output.
"""

import xml.etree.ElementTree as ET
from collections import Counter

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


def repair_measure(measure, stats):
    for events in _events(measure).values():
        # 1. beams cannot sit on rests or on notes longer than an eighth
        for event in events:
            first = event[0]
            if not _beam_states(first):
                continue
            if first.find("rest") is not None or first.findtext("type") not in BEAMABLE:
                _strip(event)
                stats["removed from rest or long note"] += 1
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


def repair_musicxml(data: bytes):
    """Return (repaired MusicXML bytes, Counter of what was done)."""
    stats = Counter()
    tree = ET.ElementTree(ET.fromstring(data))
    for part in tree.getroot().iter("part"):
        for measure in part.findall("measure"):
            repair_measure(measure, stats)
        repair_tremolos(part, stats)
    out = ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True)
    return out, stats
