import xml.etree.ElementTree as ET

from markup_repair import repair_musicxml


def note(t, beams=(), rest=False, chord=False, voice="1"):
    xml = "<note>" + ("<chord/>" if chord else "") + ("<rest/>" if rest else "<pitch><step>C</step><octave>4</octave></pitch>")
    xml += f"<duration>1</duration><voice>{voice}</voice><type>{t}</type><staff>1</staff>"
    xml += "".join(f'<beam number="{n}">{s}</beam>' for n, s in beams) + "</note>"
    return xml


def score(*notes):
    return ("<score-partwise><part id='P1'><measure number='1'>" + "".join(notes) + "</measure></part></score-partwise>").encode()


def beams_of(data):
    return [[(b.get("number"), b.text) for b in n.findall("beam")] for n in ET.fromstring(data).iter("note")]


def test_valid_group_is_kept():
    data = score(note("eighth", [(1, "begin")]), note("eighth", [(1, "end")]))
    out, stats = repair_musicxml(data)
    assert beams_of(out) == [[("1", "begin")], [("1", "end")]] and stats["beams kept"] == 2


def test_unclosed_begin_is_dropped():
    out, _ = repair_musicxml(score(note("eighth", [(1, "begin")]), note("eighth")))
    assert beams_of(out) == [[], []]


def test_beam_on_rest_and_long_note_removed():
    out, _ = repair_musicxml(score(note("quarter", [(1, "begin")], rest=True), note("whole", [(1, "begin"), (3, "forward hook")])))
    assert beams_of(out) == [[], []]


def test_stray_end_and_continue_dropped():
    out, _ = repair_musicxml(score(note("eighth", [(1, "end")]), note("eighth", [(1, "continue")])))
    assert beams_of(out) == [[], []]


def test_secondary_level_malformed_drops_whole_group():
    out, _ = repair_musicxml(score(note("16th", [(1, "begin"), (2, "begin")]), note("16th", [(1, "end")])))
    assert beams_of(out) == [[], []]


def test_secondary_level_ok_is_kept():
    out, _ = repair_musicxml(score(note("16th", [(1, "begin"), (2, "begin")]), note("16th", [(1, "end"), (2, "end")])))
    assert beams_of(out) == [[("1", "begin"), ("2", "begin")], [("1", "end"), ("2", "end")]]


def test_chord_tones_follow_their_chord():
    data = score(note("eighth", [(1, "begin")]), note("eighth", [(1, "begin")], chord=True), note("eighth"))
    out, _ = repair_musicxml(data)
    assert beams_of(out) == [[], [], []]


def test_rest_inside_a_group_does_not_break_it():
    out, _ = repair_musicxml(score(note("eighth", [(1, "begin")]), note("eighth", rest=True), note("eighth", [(1, "end")])))
    assert beams_of(out) == [[("1", "begin")], [], [("1", "end")]]


def trem(kind, t="half", measure=1):
    return f'<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>{t}</type><staff>1</staff><notations><ornaments><tremolo type="{kind}">3</tremolo></ornaments></notations></note>'


def tremolos(data):
    return [t.get("type") for t in ET.fromstring(data).iter("tremolo")]


def two_measures(a, b):
    return ("<score-partwise><part id='P1'><measure number='1'>" + a + "</measure><measure number='2'>" + b + "</measure></part></score-partwise>").encode()


def test_adjacent_tremolo_pair_in_a_measure_is_kept():
    out, stats = repair_musicxml(score(trem("start"), trem("stop")))
    assert tremolos(out) == ["start", "stop"] and stats["tremolo pairs kept"] == 1


def test_tremolo_pair_across_a_barline_is_removed():
    out, _ = repair_musicxml(two_measures(trem("start"), trem("stop")))
    assert tremolos(out) == []


def test_unclosed_and_stray_tremolos_are_removed():
    assert tremolos(repair_musicxml(score(trem("start"), note("half")))[0]) == []
    assert tremolos(repair_musicxml(score(note("half"), trem("stop")))[0]) == []


def test_tremolo_pair_with_a_note_between_is_removed():
    out, _ = repair_musicxml(score(trem("start"), note("half"), trem("stop")))
    assert tremolos(out) == []
