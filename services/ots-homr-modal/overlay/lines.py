"""Cut a page's MusicXML into one excerpt per line (system) of the scan, and fetch each line's scan crop.

The MusicXML marks the scan's own system breaks with <print new-system="yes"/>, per part. An excerpt keeps, for every
part, the measures of one system, and carries the clef, key, time and divisions in force so it stands alone.
"""

import copy
import json
import os
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ATTRIBUTE_ORDER = ["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"]


def system_ranges(part):
    """Measure index ranges [start, end) of each scan system of one part."""
    measures = part.findall("measure")
    starts = [0] + [i for i, m in enumerate(measures) if i > 0 and m.find("print") is not None and m.find("print").get("new-system") == "yes"]
    return [(a, b) for a, b in zip(starts, starts[1:] + [len(measures)])]


def system_count(root):
    return max((len(system_ranges(p)) for p in root.findall("part")), default=0)


def merge_attributes(state, attributes):
    for child in attributes:
        key = (child.tag, child.get("number")) if child.tag in ("clef", "staff-details") else child.tag
        state[key] = child
    return state


def widen_page(root):
    """Give the score a wide, short page so one scan line renders as one line, however many measures it holds."""
    defaults = root.find("defaults")
    if defaults is None:
        defaults = ET.Element("defaults")
        root.insert(1, defaults)
    for child in list(defaults):
        defaults.remove(child)
    scaling = ET.SubElement(defaults, "scaling")
    ET.SubElement(scaling, "millimeters").text = "7.0"
    ET.SubElement(scaling, "tenths").text = "40"
    layout = ET.SubElement(defaults, "page-layout")
    ET.SubElement(layout, "page-height").text = "1700"
    ET.SubElement(layout, "page-width").text = "9000"
    margins = ET.SubElement(layout, "page-margins", {"type": "both"})
    for side in ("left", "right", "top", "bottom"):
        ET.SubElement(margins, f"{side}-margin").text = "80"


def excerpt(root, system, fixed_range=None):
    """A copy of the score holding only system number `system` of every part."""
    result = copy.deepcopy(root)
    widen_page(result)
    for part in result.findall("part"):
        ranges = system_ranges(part)
        measures = part.findall("measure")
        state = {}
        if fixed_range is not None:
            a, b = fixed_range
        else:
            a, b = ranges[system] if system < len(ranges) else (len(measures), len(measures))
        for i, measure in enumerate(measures):
            all_attrs = measure.findall("attributes")
            if i < a:
                for attrs in all_attrs:
                    merge_attributes(state, attrs)
                part.remove(measure)
                continue
            if i >= b:
                part.remove(measure)
                continue
            if i == a:
                for attrs in all_attrs:
                    merge_attributes(state, attrs)
                    measure.remove(attrs)
                merged = ET.Element("attributes")
                ordered = sorted(state.items(), key=lambda kv: (ATTRIBUTE_ORDER.index(kv[0][0] if isinstance(kv[0], tuple) else kv[0]) if (kv[0][0] if isinstance(kv[0], tuple) else kv[0]) in ATTRIBUTE_ORDER else 99, str(kv[0])))
                for _, child in ordered:
                    merged.append(copy.deepcopy(child))
                measure.insert(0, merged)
            printed = measure.find("print")
            if printed is not None:
                measure.remove(printed)
        for number, measure in enumerate(part.findall("measure"), 1):
            measure.set("number", str(number))
    return result


def write_excerpts(source: Path, out_dir: Path, stem: str):
    root = ET.parse(source).getroot()
    count = system_count(root)
    paths = []
    for system in range(count):
        path = out_dir / f"{stem}-L{system + 1}.musicxml"
        ET.ElementTree(excerpt(root, system)).write(path, encoding="utf-8", xml_declaration=True)
        paths.append(path)
    return paths


def scan_systems(job_id, mongo_uri):
    """System regions of the scan, from the job's stored staff geometry: [{x0,y0,x1,y1}] ordered top to bottom."""
    script = (
        f"const j=db.scanner_jobs.findOne({{jobId:'{job_id}'}}); const r=j.pages[0].engines['ots-homr'];"
        "print(JSON.stringify(r.review.staves.map(s=>({sys:s.systemIndex,region:s.region}))))"
    )
    out = subprocess.run(["docker", "exec", "ourtextscores_mongo", "mongosh", "--quiet", mongo_uri, "--eval", script], capture_output=True, text=True, check=True, timeout=60).stdout.strip().splitlines()[-1]
    by = {}
    for staff in json.loads(out):
        x0, y0, x1, y1 = staff["region"]
        box = by.setdefault(staff["sys"], [x0, y0, x1, y1])
        box[:] = [min(box[0], x0), min(box[1], y0), max(box[2], x1), max(box[3], y1)]
    return [dict(zip(("x0", "y0", "x1", "y1"), by[k])) for k in sorted(by)]


def fetch_raster(job_id, token, api="http://localhost:4000/api/scanner/jobs"):
    request = urllib.request.Request(f"{api}/{job_id}/pages/1/lyric-candidates/scan", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def write_range_excerpt(source_root, start, end, path):
    """Excerpt of measures [start, end) of every part, standing alone."""
    ET.ElementTree(excerpt(source_root, 0, fixed_range=(start, end))).write(path, encoding="utf-8", xml_declaration=True)
