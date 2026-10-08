"""Compare frozen local HTTP exports without importing references or model code."""

import argparse
import base64
import json
import hashlib
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
    parser.add_argument(
        "--pages",
        type=Path,
        help="Frozen source-reference windows for optional native audits",
    )
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
                "structuredSymbolCountsOff": sum(
                    sum(value is not None for value in staff["structured"])
                    for staff in a["review"]["regeneration"]
                ),
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
    expected_pages = (
        len(json.loads(args.pages.read_text()))
        if args.pages
        else len(list((args.root / "off").glob("*.json"))) - 2
    )
    assert (
        len(rows) == expected_pages * 2
    ), "Expected every page and both actual inference candidates"
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
    manifest = json.loads((args.root / "candidate.json").read_text())
    if "structuredExportFamilies" in manifest:
        routing_ok = all(
            (
                row["structuredSymbolCountsOff"] == 0
                if row["candidate"] == "core"
                else row["structuredSymbolCountsOff"] > 0
            )
            for row in rows
        )
        report["distinctWorkerHeadRoutingPassed"] = routing_ok
        (args.root / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
        assert routing_ok, "Core-only/head-enabled workers are not distinct"
    if args.pages:
        from training.onnx.audit_tremolo_validation import native_measures
        from training.onnx.score_full_page_musicxml import compare, staff_events
        from training.onnx.score_paired_page_diagnostic import read_reference

        audits = []
        for page in json.loads(args.pages.read_text()):
            reference_path = Path(page["reference"])
            assert (
                hashlib.sha256(reference_path.read_bytes()).hexdigest()
                == page["reference_sha256"]
            )
            reference = staff_events(
                read_reference(reference_path),
                page["start_measure"],
                page["end_measure"],
            )
            for candidate in ("core", "additional-heads"):
                streams = {
                    arm: staff_events(
                        ET.parse(
                            args.root / arm / f'{page["score"]}-{candidate}.musicxml'
                        ).getroot()
                    )
                    for arm in ("off", "on")
                }
                measures = native_measures(reference, streams["off"], streams["on"])
                audits.append(
                    {
                        "score": page["score"],
                        "source": page["source"],
                        "candidate": candidate,
                        "metrics": {
                            arm: compare(reference, events)
                            for arm, events in streams.items()
                        },
                        "regressedNativeMeasures": [
                            m["page_bar"] for m in measures if m["regressed"]
                        ],
                    }
                )
                (
                    args.root / f'{page["score"]}-{candidate}-native-audit.json'
                ).write_text(json.dumps(measures, indent=2) + "\n")
        (args.root / "native-score-report.json").write_text(
            json.dumps(
                {
                    "cases": audits,
                    "scope": "Known positive pages; paired on/off for this local source and graph configuration, not shipping stack or independent test corpus",
                },
                indent=2,
            )
            + "\n"
        )


if __name__ == "__main__":
    main()
