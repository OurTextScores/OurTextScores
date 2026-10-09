"""Score direction/dynamic rows against the native OpenScore Lieder source (no human judging needed).

For each scanned fresh page: align the recognised voice part to the native score (per-measure pitch similarity)
to find which native measures the page shows, list the native `<words>`, `<dynamics>` and `<pedal>` directions in
that window, and compare them with the rows the scanner offered: recall (native direction offered), placement
(same measure; same onset within a quarter note), and precision (offered row matches a native direction).
Hairpins (`<wedge>`) are not read by this feature and are excluded from the ground truth.
"""

import argparse
import difflib
import json
import re
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

SOURCES = Path("/home/jhlusko/workspace/lieder-omr-data/sources/lieder-all-source/openscore-lieder")
MIN_ALIGNMENT = 0.7


def fetch(url, token):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def norm(text):
    return re.sub(r"[^a-zà-ÿ]", "", text.lower())


def similar(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b) and difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def parse_parts(root):
    """parts -> measures -> {pitches, directions[{kind,text,onset}], onsets[ordinal]=onset}"""
    parts = []
    for part in root.iter("part"):
        divisions, measures = 1, []
        for measure in part.findall("measure"):
            cursor, previous, pitches, directions, onsets = 0.0, 0.0, [], [], []
            for element in measure:
                if element.tag == "attributes" and element.findtext("divisions"):
                    divisions = float(element.findtext("divisions"))
                elif element.tag == "backup":
                    cursor -= float(element.findtext("duration") or 0) / divisions
                elif element.tag == "forward":
                    cursor += float(element.findtext("duration") or 0) / divisions
                elif element.tag == "note":
                    chord = element.find("chord") is not None
                    onset = previous if chord else cursor
                    onsets.append(onset)
                    pitch = element.find("pitch")
                    if pitch is not None:
                        pitches.append(f"{pitch.findtext('step')}{pitch.findtext('octave')}")
                    if not chord:
                        previous = onset
                        cursor += float(element.findtext("duration") or 0) / divisions
                elif element.tag == "direction":
                    for kind_element in element.iter():
                        if kind_element.tag == "words" and (kind_element.text or "").strip():
                            directions.append({"kind": "words", "text": kind_element.text.strip(), "onset": cursor})
                        elif kind_element.tag == "dynamics":
                            for child in kind_element:
                                directions.append({"kind": "dynamic", "text": child.tag, "onset": cursor})
                        elif kind_element.tag == "pedal" and kind_element.get("type") in ("start", "change"):
                            directions.append({"kind": "words", "text": "Ped.", "onset": cursor})
            measures.append({"pitches": pitches, "directions": directions, "onsets": onsets})
        parts.append(measures)
    return parts


def native_candidates(score_id, catalogue):
    """Every native source filed under this IMSLP id (an id often covers several songs of a volume)."""
    keys = [
        k
        for k, v in catalogue.items()
        if re.fullmatch(r"#?(\d+)", str(v.get("imslp", "")))
        and "IMSLP" + re.fullmatch(r"#?(\d+)", str(v["imslp"]))[1] == score_id
    ]
    for key in keys:
        for path in sorted(SOURCES.rglob(f"lc{key}.mxl")):
            archive = zipfile.ZipFile(path)
            name = next(n for n in archive.namelist() if n.endswith(".xml") and not n.startswith("META"))
            yield key, ET.fromstring(archive.read(name))


def align(page_measures, native_measures):
    """Start index in the native voice part that best matches the page's measures, and the mean similarity."""
    best = (-1, 0.0)
    count = len(page_measures)
    for start in range(0, max(1, len(native_measures) - count + 1)):
        total = 0.0
        for offset in range(min(count, len(native_measures) - start)):
            a, b = page_measures[offset]["pitches"], native_measures[start + offset]["pitches"]
            total += difflib.SequenceMatcher(None, a, b).ratio() if (a or b) else 1.0
        if total / count > best[1]:
            best = (start, total / count)
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True, help="placement-key.json from build_direction_placement_review.py")
    parser.add_argument("--token", required=True)
    parser.add_argument("--api", default="http://localhost:4000/api/scanner/jobs")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    catalogue = yaml.safe_load((SOURCES / "data/scores.yaml").read_text())
    key = json.loads(args.key.read_text())
    details = []
    report, totals = [], {"native": 0, "found": 0, "found_measure": 0, "found_onset": 0, "offered": 0, "matched": 0, "matched_measure": 0, "matched_onset": 0}
    for line in args.jobs.read_text().splitlines():
        job = json.loads(line)
        score = Path(job["image"]).parent.name
        page_root = ET.fromstring(fetch(f"{args.api}/{job['jobId']}/artifacts/musicxml?page=1&engine=ots-homr", args.token))
        page_parts = parse_parts(page_root)
        best = None
        for native_key, native_root in native_candidates(score, catalogue):
            native_parts = parse_parts(native_root)
            start, quality = align(page_parts[0], native_parts[0])
            if best is None or quality > best[0]:
                best = (quality, start, native_parts, native_key)
        if best is None:
            report.append({"score": score, "status": "no native source"})
            continue
        quality, start, native_parts, native_key = best
        if quality < MIN_ALIGNMENT:
            report.append({"score": score, "status": f"not aligned ({quality:.2f})"})
            continue
        window = len(page_parts[0])
        truth = []
        for part_index, measures in enumerate(native_parts[: len(page_parts)]):
            for offset in range(window):
                if start + offset < len(measures):
                    for d in measures[start + offset]["directions"]:
                        truth.append({**d, "part": part_index, "measure": offset + 1})
        rows = [r for r in key if r["jobId"] == job["jobId"] and r["offered"]]
        for row in rows:
            note = row["proposedNote"]
            part, ordinal = (json.loads(note["noteId"])[0], note["ordinal"]) if note else (None, None)
            row["_part"] = int(part[1:]) - 1 if part else None
            row["_measure"] = note["measure"] if note else None
            onsets = page_parts[row["_part"]][row["_measure"] - 1]["onsets"] if note and row["_part"] is not None else []
            row["_onset"] = onsets[ordinal - 1] if note and 0 < ordinal <= len(onsets) else None
        used = set()
        found = found_measure = found_onset = 0
        for t in truth:
            candidates = [r for r in rows if id(r) not in used and r["kind"] == t["kind"] and (similar(r["text"], t["text"]) if t["kind"] == "words" else norm(r["text"]) == norm(t["text"]))]
            if not candidates:
                continue
            found += 1
            same = [r for r in candidates if r["_measure"] == t["measure"]]
            if same:
                found_measure += 1
                used.add(id(same[0]))
                if any(r["_onset"] is not None and abs(r["_onset"] - t["onset"]) <= 1.0 for r in same):
                    found_onset += 1
            else:
                used.add(id(candidates[0]))
        matched = matched_measure = matched_onset = 0
        for row in rows:
            row["_status"] = "no-native-match"
            hit = [t for t in truth if t["kind"] == row["kind"] and (similar(row["text"], t["text"]) if t["kind"] == "words" else norm(row["text"]) == norm(t["text"]))]
            if hit:
                matched += 1
                same = [t for t in hit if t["measure"] == row["_measure"]]
                matched_measure += bool(same)
                right_onset = any(row["_onset"] is not None and abs(row["_onset"] - t["onset"]) <= 1.0 for t in same)
                matched_onset += right_onset
                row["_status"] = "right-onset" if right_onset else ("right-measure" if same else "wrong-measure")
        detail = {"truth": truth, "rows": [{k: r[k] for k in ("id", "text", "kind", "_part", "_measure", "_onset", "_status")} for r in rows]}
        details.append({"score": score, **detail})
        entry = {"score": score, "status": "ok", "alignment": round(quality, 2), "nativeKey": native_key, "nativeStart": start + 1, "measures": window, "native": len(truth), "found": found, "foundRightMeasure": found_measure, "foundRightOnset": found_onset, "offered": len(rows), "offeredMatchingNative": matched, "rightMeasure": matched_measure, "rightOnset": matched_onset}
        report.append(entry)
        for k, v in (("native", len(truth)), ("found", found), ("found_measure", found_measure), ("found_onset", found_onset), ("offered", len(rows)), ("matched", matched), ("matched_measure", matched_measure), ("matched_onset", matched_onset)):
            totals[k] += v
    args.out.write_text(json.dumps({"pages": report, "totals": totals, "details": details}, indent=1))
    for r in report:
        print(r)
    print("TOTALS", totals)


if __name__ == "__main__":
    main()
