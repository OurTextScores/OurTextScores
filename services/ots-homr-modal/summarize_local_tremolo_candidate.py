"""Compare frozen local HTTP exports without importing references or model code."""

import argparse
import base64
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def inventory(root):
    return [
        (
            note.findtext("pitch/step"),
            note.findtext("pitch/alter"),
            note.findtext("pitch/octave"),
            note.findtext("type"),
            len(note.findall("dot")),
            note.find("rest") is not None,
            note.find("chord") is not None,
        )
        for note in root.findall("part/measure/note")
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    rows = []
    for source in sorted((args.root / "off").glob("*.json")):
        if source.name in ("report.json", "complete.json"):
            continue
        off = json.loads(source.read_text())
        on = json.loads((args.root / "on" / source.name).read_text())
        assert off["inputSha256"] == on["inputSha256"]
        for name in ("core", "additional-heads"):
            a = off["result"]["candidates"][name]
            b = on["result"]["candidates"][name]
            axml = base64.b64decode(a["musicXmlBase64"])
            bxml = base64.b64decode(b["musicXmlBase64"])
            ar, br = ET.fromstring(axml), ET.fromstring(bxml)
            row = {
                "score": source.stem,
                "candidate": name,
                "xmlChanged": axml != bxml,
                "pitchAndWrittenDurationInventoryUnchanged": inventory(ar)
                == inventory(br),
                "measureCountsOff": [
                    len(p.findall("measure")) for p in ar.findall("part")
                ],
                "measureCountsOn": [
                    len(p.findall("measure")) for p in br.findall("part")
                ],
                "decodeTokensUnchanged": [
                    s["tokens"] for s in a["review"]["regeneration"]
                ]
                == [s["tokens"] for s in b["review"]["regeneration"]],
            }
            rows.append(row)
            for arm, xml in (("off", axml), ("on", bxml)):
                (args.root / arm / f"{source.stem}-{name}.musicxml").write_bytes(xml)
    assert len(rows) == 4, "Expected two pages and both actual inference candidates"
    report = {
        "scope": "Local CPU supervised workers through HTTP TestClient; OCR and text detectors disabled; no production GPU latency or new accuracy claim",
        "rows": rows,
        "checksPassed": all(
            r["pitchAndWrittenDurationInventoryUnchanged"]
            and r["decodeTokensUnchanged"]
            and r["measureCountsOff"] == r["measureCountsOn"]
            for r in rows
        ),
    }
    (args.root / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    assert report["checksPassed"], "Local integration invariant changed"


if __name__ == "__main__":
    main()
