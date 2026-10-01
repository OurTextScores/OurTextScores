"""Prepare score-disjoint fusion adjudication inputs, never fit partial labels as negatives.

Known positives are carried forward with provenance. Unmatched ink remains unknown,
except Lyrics on instrumental OSSQ pages. This does not create a runtime calibration.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

from PIL import Image

from fusion_policy import CLASS_ALLOWLIST, SEMANTIC_FAMILY
from pins import DETECTOR_ROUTES, LOGICAL_DETECTORS

SEED = 'ots-text-fusion-20261001'


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def partition(score):
    # Every page/annotation/image variant of a score has the same assignment.
    value = int(hashlib.sha256(f'{SEED}:{score}'.encode()).hexdigest()[:8], 16) / 2**32
    return 'calibration' if value < .6 else 'test'


def pixel_identity(path):
    # Read trusted local scan headers without allocating huge raster buffers.
    # This is an explicit preparation budget, not a claimed production limit.
    limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(path) as image:
            width, height = image.size
            if width * height > 30_000_000:
                raise ValueError(f'oversized-page-deferred: {width}x{height}; preparation budget 30000000 pixels; original not resized')
            rgb = image.convert('RGB')
            digest = hashlib.sha256(f'{width}x{height}:RGB:'.encode() + rgb.tobytes()).hexdigest()
    finally:
        Image.MAX_IMAGE_PIXELS = limit
    return digest, width, height


def normalize_box(value, width, height):
    left, top = value['left'], value['top']
    right = value.get('right', left + value.get('width', 0))
    bottom = value.get('bottom', top + value.get('height', 0))
    box = (left, top, right, bottom)
    if any(not isinstance(n, (int, float)) or n != int(n) for n in box):
        raise ValueError('Non-integer annotation geometry')
    left, top, right, bottom = map(int, box)
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('Annotation outside original image')
    return [left, top, right, bottom]


def prepare(workspace, out, excluded_scores=()):
    excluded_scores = set(excluded_scores)
    groups = {}
    problems = []
    excluded = Counter()
    sources = [
        ('ossq-boxes', workspace / 'homr-artifacts/ground_truth/ossq_boxes'),
        ('lieder-directions', workspace / 'homr-artifacts/ground_truth/lieder_boxes'),
        ('lieder-lyrics-mapped', workspace / 'homr-artifacts/detector-retrain-20260918/lieder_lyrics'),
    ]
    pixel_cache = {}
    out.mkdir(parents=True, exist_ok=True)
    cache_path = out / 'image-hash-cache.jsonl'
    hash_cache = {}
    if cache_path.exists():
        with cache_path.open('rb+') as handle:
            while line := handle.readline():
                offset = handle.tell() - len(line)
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    if line.endswith(b'\n') or handle.read(1):
                        raise
                    handle.truncate(offset)
                    break
                if not line.endswith(b'\n'):
                    handle.truncate(offset)
                    break
                hash_cache[record['path']] = record

    def add(image, annotation, score, corpus, boxes, reference_kind):
        if score in excluded_scores:
            excluded[score] += 1
            return
        if not image.is_file():
            problems.append(dict(annotation=str(annotation), image=str(image), reason='missing-image'))
            return
        if image not in pixel_cache:
            stat = image.stat()
            cached = hash_cache.get(str(image))
            if cached and cached['mtime_ns'] == stat.st_mtime_ns and cached['bytes'] == stat.st_size:
                pixel_cache[image] = (cached['pixel_sha256'], cached['width'], cached['height'])
            else:
                try:
                    pixel_cache[image] = pixel_identity(image)
                except (ValueError, OSError) as error:
                    problems.append(dict(annotation=str(annotation), image=str(image), reason=str(error)))
                    return
                pixel, width, height = pixel_cache[image]
                cached = dict(path=str(image), mtime_ns=stat.st_mtime_ns, bytes=stat.st_size,
                              pixel_sha256=pixel, width=width, height=height, image_sha256=sha(image))
                with cache_path.open('a') as handle:
                    handle.write(json.dumps(cached)+'\n')
                hash_cache[str(image)] = cached
        pixel, width, height = pixel_cache[image]
        key = (score, pixel)
        if key not in groups:
            groups[key] = dict(id=f'{score}:{pixel[:24]}', score=score, partition=partition(score),
                               image=str(image), image_sha256=hash_cache[str(image)]['image_sha256'], pixel_sha256=pixel,
                               width=width, height=height, corpus='ossq' if score.startswith('sq') else 'lieder',
                               annotations=[], ground_truth=[], complete_semantic_families=['Lyrics'] if score.startswith('sq') else [],
                               unmatched_policy='unknown-until-adjudicated', detector_training_membership='unverified')
        page = groups[key]
        if len(groups) % 100 == 0 and not page['annotations']:
            print(f'Prepared {len(groups)} unique pages; {len(problems)} input issues/deferred records', flush=True)
        page['annotations'].append(dict(path=str(annotation), sha256=sha(annotation), source=corpus,
                                        image=str(image), reference_kind=reference_kind))
        for box in boxes:
            label = box['label']
            family = SEMANTIC_FAMILY.get(label)
            if family is None:
                continue
            try:
                geometry = normalize_box(box['box'], width, height)
            except (ValueError, KeyError, TypeError, OverflowError) as error:
                problems.append(dict(annotation=str(annotation), reason=str(error), box=box))
                continue
            truth = dict(label=label, semanticFamily=family, box=geometry, annotation=str(annotation),
                         reference_kind=reference_kind)
            for field in ('text', 'verse', 'matched_fraction', 'match_ratio', 'ocr_confidence'):
                if field in box:
                    truth[field] = box[field]
            page['ground_truth'].append(truth)

    for corpus, folder in sources:
        for annotation in sorted(folder.rglob('*.boxes.json')):
            data = json.loads(annotation.read_text())
            score = annotation.parent.name
            image = (annotation.parent / data['image']).resolve()
            if not image.is_file() and corpus == 'lieder-lyrics-mapped':
                image = workspace / 'homr-artifacts/ground_truth/lieder_boxes' / score / Path(data['image']).name
            boxes = [dict(label=label, box=box) for label, values in data.get('text_boxes', {}).items() for box in values]
            boxes += [dict(label='Lyrics', box=box) for box in data.get('lyrics', [])]
            add(image, annotation, score, corpus, boxes, 'partial-page-positive-labels')
    vocal = workspace / 'homr-artifacts/datasets/lieder_vocal_text'
    for annotation in sorted(vocal.glob('*.json')):
        data = json.loads(annotation.read_text())
        score = data.get('score_id', annotation.stem)
        pages = defaultdict(list)
        for match in data.get('matches', []):
            label = {'lyric': 'Lyrics', 'dynamic': 'Dynamic'}.get(match.get('kind'))
            if label is None or not match.get('page_image'):
                continue
            box = dict(label=label, box=match['box'], text=match.get('text'), verse=match.get('verse'),
                       ocr_confidence=match.get('score'))
            for field in ('matched_fraction', 'match_ratio'):
                if field in match:
                    box[field] = match[field]
            pages[match['page_image']].append(box)
        for name, boxes in sorted(pages.items()):
            add(vocal / 'pages' / score / name, annotation, score, 'lieder-ocr-score-matched', boxes,
                'ocr-score-matched-positive; text/verse evidence, not note-attachment truth')
    rows = sorted(groups.values(), key=lambda r: (r['partition'], r['corpus'], r['score'], r['id']))
    # Deduplicate coincident same-family boxes while keeping every annotation's evidence.
    for row in rows:
        evidence = defaultdict(list)
        for box in row.pop('ground_truth'):
            evidence[(box['semanticFamily'], tuple(box['box']))].append(box)
        row['ground_truth'] = [dict(semanticFamily=family, box=list(box), evidence=values)
                               for (family, box), values in sorted(evidence.items())]
    calibration_scores = {r['score'] for r in rows if r['partition'] == 'calibration'}
    test_scores = {r['score'] for r in rows if r['partition'] == 'test'}
    assert not calibration_scores & test_scores
    out.mkdir(parents=True, exist_ok=True)
    for split in ('calibration', 'test'):
        (out / f'{split}-pages.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows if r['partition'] == split))
    policy = dict(schemaVersion='ots.text-fusion-preparation.v1', seed=SEED, status='preparation-only; not runtime calibration',
                  logicalDetectors={k: dict(repository=repo, revision=rev, artifact=file, sha256=digest,
                                            physicalDetectorId=DETECTOR_ROUTES[k], classAllowlist=sorted(CLASS_ALLOWLIST[k]))
                                    for k, (repo, rev, file, digest) in LOGICAL_DETECTORS.items()},
                  automaticDynamics=False, fittedCalibrators=None, acceptanceThresholds=None,
                  blockers=['Adjudicate unmatched predictions and cross-detector overlaps on calibration pages',
                            'Verify exclusions against the exact released detectors training score identities',
                            'Freeze region-match/acceptance/margin criteria before examining test outcomes',
                            'Fit calibrated probabilities on calibration partition; evaluate independent test partition',
                            'C1 lyric recognition/note/verse attachment and final-path latency remain separate'])
    (out / 'preparation-policy.json').write_text(json.dumps(policy, indent=2) + '\n')
    stats = dict(pages=len(rows), scores=len(calibration_scores | test_scores),
                 partition_pages=dict(Counter(r['partition'] for r in rows)),
                 partition_scores=dict(calibration=len(calibration_scores), test=len(test_scores)),
                 corpus_pages=dict(Counter(r['corpus'] for r in rows)),
                 known_positive_boxes=dict(Counter(b['semanticFamily'] for r in rows for b in r['ground_truth'])),
                 score_overlap=0, excluded_scores=sorted(excluded_scores), excluded_annotation_records=dict(excluded),
                 invalid_or_missing=len(problems), scripts_sha256=sha(__file__),
                 preparation_max_pixels=30_000_000,
                 readiness='NOT_CALIBRATED; unknown unmatched regions, unverified detector-training membership',
                 outputs={name: sha(out / name) for name in ('calibration-pages.jsonl', 'test-pages.jsonl', 'preparation-policy.json')})
    (out / 'audit.json').write_text(json.dumps(stats, indent=2) + '\n')
    (out / 'input-problems.json').write_text(json.dumps(problems, indent=2) + '\n')
    print(json.dumps(stats, indent=2), flush=True)
    return rows, stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--exclude-scores', type=Path, help='JSON array of verified detector-training score identities')
    args = parser.parse_args()
    exclude = json.loads(args.exclude_scores.read_text()) if args.exclude_scores else []
    if not isinstance(exclude, list) or not all(isinstance(s, str) for s in exclude):
        parser.error('--exclude-scores must contain a JSON array of score IDs')
    prepare(args.workspace.resolve(), args.out.resolve(), exclude)


if __name__ == '__main__':
    main()
