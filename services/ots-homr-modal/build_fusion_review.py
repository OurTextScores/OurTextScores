"""Build an original-image calibration preview; raw detector scores are not probabilities."""
import argparse
from html import escape
import json
from pathlib import Path
import shutil

from PIL import Image

COLORS = {'Lyrics': '#1479ca', 'DirectionText': '#cb6510', 'Dynamic': '#9c39b5'}


def panel(image, width, height, boxes, truth=False):
    marks = []
    for box in boxes:
        family = box.get('semanticFamily')
        if family not in COLORS or (not truth and not box['admissible']):
            continue
        left, top, right, bottom = box['box']
        label = family if truth else f"{box['label']}, {box['detectorId']}, raw {box['rawConfidence']:.3f}"
        marks.append(f'<rect x="{left}" y="{top}" width="{right-left}" height="{bottom-top}" '
                     f'fill="none" stroke="{COLORS[family]}" stroke-width="3" vector-effect="non-scaling-stroke">'
                     f'<title>{escape(label)}</title></rect>')
    return (f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Page with region overlays">'
            f'<image href="{escape(image)}" width="{width}" height="{height}"/>' + ''.join(marks) + '</svg>')


def build(detections, out):
    out.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in detections.open()]
    if not rows or any(row['partition'] != 'calibration' for row in rows):
        raise ValueError('Preview requires calibration-only records')
    cards = []
    for index, row in enumerate(rows):
        source = Path(row['image'])
        target = f'page-{index}{source.suffix}'
        shutil.copyfile(source, out / target)
        with Image.open(source) as image:
            width, height = image.size
        details = ''.join(f'<li style="border-left:4px solid {COLORS.get(c["semanticFamily"], "#777")}">'
                          f'{escape(c["label"])} — {escape(c["detectorId"])} '
                          f'(physical {escape(c["physicalDetectorId"])}), raw score {c["rawConfidence"]:.3f}; '
                          f'known-positive overlap {c["maximumKnownPositiveIoU"]:.3f}; '
                          f'{"confirmed no-lyrics false positive" if c["correctness"] is False else "unadjudicated"}</li>'
                          for c in row['candidates'] if c['admissible'])
        cards.append(f'<article><h2>{escape(row["score"])} — {row["seconds"]:.1f}s, '
                     f'{row["physicalPasses"]} physical detector passes</h2><div class="pair">'
                     f'<section><h3>Existing positive annotations</h3>{panel(target,width,height,row["ground_truth"],True)}</section>'
                     f'<section><h3>Pinned detectors, routed once</h3>{panel(target,width,height,row["candidates"])}</section>'
                     f'</div><details><summary>Candidate evidence</summary><ul>{details}</ul></details></article>')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Text fusion calibration preview</title><style>
body{font:16px system-ui;background:#f5f5f2;color:#202124;margin:24px;max-width:1800px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}svg{width:100%;background:white}
article{margin:36px 0;padding:20px;background:#fff;border:1px solid #bbb}li{padding:6px 12px;margin:8px 0}
@media(max-width:800px){.pair{grid-template-columns:1fr}}
</style><h1>Text fusion: calibration preview</h1>
<p>Blue: lyrics. Orange: direction text. Purple: dynamics. Hover over a box for its label.
These are original page images, with no re-engraving or coordinate changes.</p>
<p>This preview checks routing and annotation coverage. Existing labels are partial positives;
an unmatched detection is unknown, except lyrics on instrumental OSSQ pages.
Raw confidence is uncalibrated. Dynamics remains review-only. No automatic output or promotion is proposed.</p>
<p>Two calibration pages were selected deterministically before inference. Test pages remain unused.
Detector-training membership is still unverified; this is not an independent accuracy benchmark.</p>
''' + ''.join(cards) + '</html>'
    (out / 'index.html').write_text(page)
    shutil.copyfile(detections, out / 'detections.jsonl')
    shutil.copyfile(detections.parent / 'identity.json', out / 'identity.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--detections', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    build(args.detections, args.out)
