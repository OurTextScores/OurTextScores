"""Link reviewed calibration pages to native lyric windows, not note pixel boxes."""

import argparse
import json
import xml.etree.ElementTree as ET
import zipfile
from itertools import pairwise
from pathlib import Path

from prepare_c1_lyric_references import lyrics, sha
from prepare_fusion_calibration import pixel_identity


def system_for_measure(systems, physical_measure):
    matches = [
        s for s in systems if s["start_measure"] < physical_measure <= s["end_measure"]
    ]
    if len(matches) != 1:
        raise ValueError("Native measure has no unique page system")
    return matches[0]["system_index"]


def check_systems(systems):
    ordered = sorted(systems, key=lambda s: s["system_index"])
    if not ordered or [s["system_index"] for s in ordered] != list(range(len(ordered))):
        raise ValueError("Incomplete page systems")
    if any(
        s.get("status") != "aligned"
        or s.get("boundary_certified") is not True
        or s.get("count_exact") is not True
        or s["end_measure"] <= s["start_measure"]
        for s in ordered
    ):
        raise ValueError("Uncertified independent system boundary")
    if any(a["end_measure"] != z["start_measure"] for a, z in pairwise(ordered)):
        raise ValueError("Non-contiguous page windows")
    return ordered


def run(
    selection, review, calibration_pages, alignment, source_refs, source_audit, out
):
    if out.exists():
        raise ValueError("Output must be new")
    chosen = json.loads(selection.read_text())
    reviewed = json.loads(review.read_text())
    if reviewed.get("selection_sha256") != sha(selection) or not reviewed.get(
        "reviewer"
    ):
        raise ValueError("Missing identity-bound review")
    if (
        reviewed.get("model_predictions_used") is not False
        or reviewed.get("OCR_text_used") is not False
    ):
        raise ValueError("Independent visual/native review required")
    split = {
        p["id"]: p for p in map(json.loads, calibration_pages.read_text().splitlines())
    }
    references = list(map(json.loads, source_refs.read_text().splitlines()))
    audited = json.loads(source_audit.read_text())
    independent = json.loads(alignment.read_text())
    if independent.get("model_predictions_used") is not False:
        raise ValueError("Independent alignment required")
    pages, targets = [], []
    for item in chosen:
        page = item["page"]
        if page.get("partition") != "calibration" or split.get(page["id"]) != page:
            raise ValueError("Page is not an unchanged calibration input")
        if (
            sha(page["image"]) != page["image_sha256"]
            or pixel_identity(Path(page["image"]))[0] != page["pixel_sha256"]
        ):
            raise ValueError("Original page changed")
        systems = check_systems(item["systems"])
        actual = [
            s
            for s in independent["scores"][page["score"]]["systems"]
            if Path(s["page_image"]).name == Path(page["image"]).name
        ]
        if sorted(actual, key=lambda s: s["system_index"]) != systems:
            raise ValueError("Selected systems differ from independent alignment")
        evidence = reviewed["pages"][page["id"]]
        for flag in (
            "edition_identity_checked",
            "part_order_checked",
            "complete_page_checked",
        ):
            if evidence.get(flag) is not True:
                raise ValueError("Incomplete page visual review")
        if evidence["visible_system_measure_counts"] != [
            s["end_measure"] - s["start_measure"] for s in systems
        ]:
            raise ValueError("Visual bar counts disagree")
        source = audited["scores"][page["score"]]
        if sha(source["source"]) != source["source_sha256"]:
            raise ValueError("Native source changed")
        with zipfile.ZipFile(source["source"]) as archive:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
            roots = container.findall(".//{*}rootfile")
            if len(roots) != 1:
                raise ValueError("Ambiguous native MusicXML root")
            root = ET.fromstring(archive.read(roots[0].get("full-path")))
        counts = [len(p.findall("measure")) for p in root.findall("part")]
        if (
            not counts
            or len(set(counts)) != 1
            or systems[-1]["end_measure"] > counts[0]
        ):
            raise ValueError("Page window outside equally counted native parts")
        rows = [r for r in references if r["score"] == page["score"]]
        if rows != lyrics(root, page["score"]):
            raise ValueError("Stored lyric references differ from native source")
        selected = [
            r
            for r in rows
            if systems[0]["start_measure"]
            < r["physical_measure"]
            <= systems[-1]["end_measure"]
        ]
        for anchor in evidence["anchors"]:
            matched = [
                r
                for r in selected
                if all(
                    (
                        r["source_part"] == anchor["source_part"],
                        r["physical_measure"] == anchor["physical_measure"],
                        r["source_note_ordinal"] == anchor["source_note_ordinal"],
                        r["verse_number"] == anchor["source_verse"],
                    )
                )
            ]
            if len(matched) != 1 or matched[0]["text"] != anchor["native_text"]:
                raise ValueError("Visible anchor differs from native target")
            if (
                system_for_measure(systems, anchor["physical_measure"])
                != anchor["system_index"]
            ):
                raise ValueError("Anchor outside reviewed system")
        verses = sorted({r["verse_number"] for r in selected})
        if sorted(evidence["source_verse_order_top_to_bottom"]) != verses:
            raise ValueError("Visual verse map does not cover native verses")
        for row in selected:
            targets.append(
                {
                    **row,
                    "page_id": page["id"],
                    "scan_system_index": system_for_measure(
                        systems, row["physical_measure"]
                    ),
                    "scan_linkage": "reviewed-page-and-system-window",
                    "note_pixel_attachment_certified": False,
                }
            )
        pages.append(
            {
                "id": page["id"],
                "score": page["score"],
                "partition": "calibration",
                "image": page["image"],
                "image_sha256": page["image_sha256"],
                "pixel_sha256": page["pixel_sha256"],
                "source": source,
                "start_measure": systems[0]["start_measure"],
                "end_measure": systems[-1]["end_measure"],
                "systems": systems,
                "native_lyric_targets": len(selected),
                "review": evidence,
                "scope": "Native source-to-original scan page/system and visible phrase/verse anchors; not exhaustive per-syllable transcription or note pixels",
            }
        )
    out.mkdir(parents=True)
    (out / "pages.json").write_text(json.dumps(pages, indent=2) + "\n")
    (out / "targets.jsonl").write_text("".join(json.dumps(r) + "\n" for r in targets))
    (out / "receipt.json").write_text(
        json.dumps(
            {
                "tool_sha256": sha(__file__),
                "inputs": {
                    str(p): sha(p)
                    for p in (
                        selection,
                        review,
                        calibration_pages,
                        alignment,
                        source_refs,
                        source_audit,
                    )
                },
                "pages": len(pages),
                "targets": len(targets),
                "model_predictions_used": False,
                "OCR_text_used": False,
                "heldout_test_used": False,
                "note_pixel_attachment_certified": False,
                "outputs": {n: sha(out / n) for n in ("pages.json", "targets.jsonl")},
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "selection",
        "review",
        "calibration-pages",
        "alignment",
        "source-refs",
        "source-audit",
        "out",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    run(
        args.selection,
        args.review,
        args.calibration_pages,
        args.alignment,
        args.source_refs,
        args.source_audit,
        args.out,
    )
