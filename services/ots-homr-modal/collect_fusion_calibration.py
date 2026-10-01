"""Collect pinned physical detections for fusion adjudication, without making labels up."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
import torch

from detector_routes import route_detections
from detector_runtime.runtime import TextDetector
from fusion_policy import CLASS_ALLOWLIST, SEMANTIC_FAMILY
from fusion_v1 import _candidate_id
from pins import DETECTORS, DETECTOR_ROUTES, LOGICAL_DETECTORS
from prepare_fusion_calibration import pixel_identity, sha


def iou(a, b):
    width = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    intersection = width * height
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union else 0.


def collect(pages, models_root, out, device='cpu', threads=2, batch_size=2):
    torch.set_num_threads(threads)
    out.mkdir(parents=True, exist_ok=True)
    identity = dict(schemaVersion='ots.text-fusion-detections.v1', pages_sha256=sha(pages),
                    collector_sha256=sha(__file__), torch=str(torch.__version__), device=device,
                    numpy=str(np.__version__), opencv=str(cv2.__version__),
                    implementation_sha256={name: sha(Path(__file__).parent / name) for name in
                                           ('detector_runtime/runtime.py', 'detector_runtime/camvid_model.py',
                                            'detector_runtime/detector_inference.py',
                                            'detector_runtime/detector_patches.py',
                                            'detector_runtime/detector_masks.py', 'detector_runtime/detector_data.py',
                                            'detector_routes.py', 'fusion_policy.py', 'fusion_v1.py', 'pins.py')},
                    logical_routes=DETECTOR_ROUTES,
                    threads=threads, batch_size=batch_size,
                    physical_detectors={k: dict(repository=repo, revision=rev, artifact=file, sha256=digest)
                                        for k, (repo, rev, file, digest) in DETECTORS.items()},
                    mode='Production TextDetector.detect; no resized input, no raw-score acceptance or fitted calibration')
    identity_path = out / 'identity.json'
    if identity_path.exists() and json.loads(identity_path.read_text()) != identity:
        raise ValueError('Collector resume identity changed')
    identity_path.write_text(json.dumps(identity, indent=2)+'\n')
    detectors = {}
    for key, (repo, rev, file, digest) in DETECTORS.items():
        detectors[key] = TextDetector(detector_id=key, checkpoint=models_root / repo.replace('/', '--') / file,
                                      revision=rev, sha256=digest, device=device)
    rows = [json.loads(line) for line in pages.open()]
    results = out / 'detections.jsonl'
    done = set()
    if results.exists():
        # Only recover a truncated final write; malformed completed rows are errors.
        with results.open('rb+') as previous:
            while line := previous.readline():
                offset = previous.tell() - len(line)
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    if line.endswith(b'\n') or previous.read(1):
                        raise
                    previous.truncate(offset)
                    break
                if not line.endswith(b'\n'):
                    previous.truncate(offset)
                    break
                if record['id'] in done:
                    raise ValueError('Duplicate completed page')
                done.add(record['id'])
    if not done.issubset({row['id'] for row in rows}):
        raise ValueError('Resume contains pages outside the pinned input index')
    with results.open('a') as handle:
        for page in rows:
            if page['id'] in done:
                continue
            if sha(page['image']) != page['image_sha256'] or pixel_identity(Path(page['image']))[0] != page['pixel_sha256']:
                raise ValueError('Original input image changed')
            tick = time.monotonic()
            content = Path(page['image']).read_bytes()
            decoded = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
            if decoded is None:
                raise ValueError('Image could not be decoded')
            pixel_sha = hashlib.sha256(decoded.tobytes()).hexdigest()
            physical = {key: model.detect(content, batch_size=batch_size) for key, model in detectors.items()}
            routed = route_detections(physical)
            candidates = []
            for key, boxes in routed.items():
                revision = LOGICAL_DETECTORS[key][1]
                for box in boxes:
                    geometry = [box[f] for f in ('left', 'top', 'right', 'bottom')]
                    label = box['label']
                    family = SEMANTIC_FAMILY.get(label)
                    known = [iou(geometry, b['box']) for b in page['ground_truth'] if b['semanticFamily'] == family]
                    admissible = label in CLASS_ALLOWLIST[key]
                    candidates.append(dict(id=_candidate_id(pixel_sha, key, revision, label, tuple(geometry)),
                                           detectorId=key, physicalDetectorId=DETECTOR_ROUTES[key],
                                           label=label, semanticFamily=family, box=geometry, rawConfidence=box['confidence'],
                                           admissible=admissible, maximumKnownPositiveIoU=max(known, default=0.),
                                           correctness=False if admissible and family == 'Lyrics' and page['corpus'] == 'ossq' else None,
                                           correctnessReason='instrumental-OSSQ-has-no-lyrics' if admissible and family == 'Lyrics' and page['corpus'] == 'ossq' else 'adjudication-or-prespecified-positive-match-required'))
            record = dict(id=page['id'], score=page['score'], partition=page['partition'], image=page['image'],
                          image_sha256=page['image_sha256'], production_pixel_sha256=pixel_sha,
                          physicalPasses=len(physical), seconds=time.monotonic()-tick,
                          candidates=candidates, ground_truth=page['ground_truth'],
                          counts=dict(Counter(c['detectorId'] for c in candidates)))
            handle.write(json.dumps(record)+'\n')
            handle.flush()
            done.add(page['id'])
            (out / 'progress.json').write_text(json.dumps(dict(completed=len(done), total=len(rows),
                                             last_seconds=record['seconds'], updated=time.time()), indent=2)+'\n')
            print(f'{len(done)}/{len(rows)} {page["score"]}: two physical passes, {len(candidates)} candidates, {record["seconds"]:.1f}s', flush=True)
    (out / 'COMPLETE').write_text('Collection finished; no calibration fitted or fusion enabled.\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pages', type=Path, required=True)
    parser.add_argument('--models-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--batch-size', type=int, default=2)
    args = parser.parse_args()
    collect(args.pages, args.models_root, args.out, args.device, args.threads, args.batch_size)


if __name__ == '__main__':
    main()
