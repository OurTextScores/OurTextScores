"""Prepare source-owned lyric targets; never claim scan/recognizer alignment."""

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

import yaml


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def lyrics(root, score):
    for element in root.iter():
        element.tag = element.tag.rsplit("}", 1)[-1]
    if root.tag != "score-partwise":
        raise ValueError("Only score-partwise source ownership is supported")
    rows = []
    for part in root.findall("part"):
        divisions = None
        for measure_index, measure in enumerate(part.findall("measure"), 1):
            cursor = Fraction(0)
            previous_onset = None
            note_index = 0
            for child in measure:
                if child.tag == "attributes":
                    value = child.findtext("divisions")
                    if value is not None:
                        divisions = int(value)
                        if divisions <= 0:
                            raise ValueError("Non-positive source divisions")
                duration = child.findtext("duration")
                if duration is not None and divisions is None:
                    raise ValueError("Duration before declared divisions")
                quarters = (
                    Fraction(int(duration), divisions)
                    if duration is not None
                    else Fraction(0)
                )
                if child.tag == "backup":
                    cursor -= quarters
                elif child.tag == "forward":
                    cursor += quarters
                elif child.tag == "note":
                    note_index += 1
                    chord = child.find("chord") is not None
                    if chord and previous_onset is None:
                        raise ValueError("Chord has no preceding source note")
                    onset = previous_onset if chord else cursor
                    if not chord:
                        previous_onset = onset
                        cursor += quarters
                    for lyric_index, lyric in enumerate(child.findall("lyric"), 1):
                        segments = [
                            {
                                "kind": x.tag,
                                "text": x.text or "",
                                "attributes": dict(x.attrib),
                            }
                            for x in lyric
                            if x.tag in ("text", "elision", "syllabic", "extend")
                        ]
                        rows.append(
                            {
                                "score": score,
                                "source_part": part.get("id"),
                                "physical_measure": measure_index,
                                "printed_measure": measure.get("number"),
                                "source_note_ordinal": note_index,
                                "source_note_id": child.get("id"),
                                "lyric_ordinal": lyric_index,
                                "voice": child.findtext("voice"),
                                "staff": child.findtext("staff"),
                                "onset_quarters": str(onset),
                                "duration_quarters": str(quarters),
                                "grace": child.find("grace") is not None,
                                "rest": child.find("rest") is not None,
                                "pitch": (
                                    {x.tag: x.text for x in child.find("pitch")}
                                    if child.find("pitch") is not None
                                    else None
                                ),
                                "verse_number": lyric.get("number"),
                                "verse_name": lyric.get("name"),
                                "text": "".join(
                                    x["text"]
                                    for x in segments
                                    if x["kind"] in ("text", "elision")
                                ),
                                "segments": segments,
                                "scan_linkage": "uncertified",
                            }
                        )
    return rows


def run(pages, catalogue, source_root, out):
    if out.exists():
        raise ValueError("Output must be new")
    pages_rows = [json.loads(line) for line in pages.open()]
    if any(row["partition"] != "calibration" for row in pages_rows):
        raise ValueError("Only calibration pages may prepare this pilot")
    scores = sorted({p["score"] for p in pages_rows if p["corpus"] == "lieder"})
    identities = defaultdict(list)
    for key, entry in yaml.safe_load(catalogue.read_text()).items():
        match = re.fullmatch(r"#?(\d+)", str(entry.get("imslp", "")))
        if match:
            identities["IMSLP" + match[1]].append(str(key))
    sources = defaultdict(list)
    for path in source_root.rglob("lc*.mxl"):
        sources[path.stem[2:]].append(path)
    out.mkdir(parents=True)
    audit = {
        "pages_sha256": sha(pages),
        "catalogue_sha256": sha(catalogue),
        "script_sha256": sha(__file__),
        "scores": {},
        "problems": [],
        "scope": "Source-only lyric/verse/note targets; no scan alignment or C1 accuracy claim",
    }
    with (out / "source-lyrics.jsonl").open("w") as handle:
        for score in scores:
            keys = identities[score]
            paths = sources[keys[0]] if len(keys) == 1 else []
            if len(paths) != 1:
                audit["problems"].append(
                    {"score": score, "reason": "missing-or-ambiguous-native-source"}
                )
                continue
            path = paths[0]
            with zipfile.ZipFile(path) as archive:
                container = ET.fromstring(archive.read("META-INF/container.xml"))
                roots = container.findall(".//{*}rootfile")
                if len(roots) != 1:
                    raise ValueError("Ambiguous compressed MusicXML root")
                xml = archive.read(roots[0].get("full-path"))
            rows = lyrics(ET.fromstring(xml), score)
            for row in rows:
                handle.write(json.dumps(row) + "\n")
            audit["scores"][score] = {
                "source": str(path),
                "source_sha256": sha(path),
                "xml_sha256": hashlib.sha256(xml).hexdigest(),
                "lyric_entries": len(rows),
            }
    (out / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("pages", "catalogue", "source-root", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    run(args.pages, args.catalogue, args.source_root, args.out)
