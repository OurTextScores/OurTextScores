# OTS-HOMR Modal provider source inputs

This directory is the reproducible input set for the dedicated OTS-HOMR GPU
provider. It is intentionally separate from `services/homr-modal`: upstream
HOMR must remain independently deployable.

## Pinned runtime source

The rareNum core and structured-head sidecar were produced from upstream HOMR
commit `997b70a88c9f945b632f4129b036b2cd0972b2a3` plus
`patches/homr-997-runtime.patch`, followed by the review-policy change from
HOMR commit `48a2b35a2142689d3a8ad324d60162542dbd3ef7`.

That commit was local to the training branch and is not reachable from upstream
GitHub. `source/homr-997b70-source.tar.gz` is therefore the immutable clean-tree
archive used by Modal. Its SHA-256 is
`819eca26f26e977e2a376d03c8aa4ddaf1f631db69a87ccc9d1ad943f75b4de9`.

The main patch is restricted to the inference/runtime files required for the
rareNum and structured-head paths. It deliberately excludes training and corpus
changes from the source instance. Its SHA-256 is:

```text
4970d1eeaedce7a5444ff70764a8662b1f0a6d47c0f564073342628048245898
```

`patches/homr-structured-review.patch` retains uncertainty alternatives for all
five selectable head families while continuing to exclude dynamics and
under-supported beam level 4. Its SHA-256 is:

```text
4fbcac3691c63c26a4b146458a7e4513ee5a90e450e734aa2a8c1836a4ed063d
```

The Modal image verifies and extracts that archive, applies both patches with
`git apply --check` followed by `git apply`, and fails the build on any mismatch.
Because a clean archive has no `.git` metadata, the package install sets
`POETRY_DYNAMIC_VERSIONING_BYPASS=0.0.0`, matching HOMR's declared static
fallback version instead of asking its build backend to inspect a nonexistent
checkout.

## Pinned private model inputs

| Role | Private repository / revision | File / SHA-256 |
| --- | --- | --- |
| core | `jhlusko/OTS-homr@1dbc87399c70238136da0dfd412fff032d17b76c` | `encoder.onnx` / `f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1`; `decoder.onnx` / `7abc3ea71caac8f5a4fd9a96f0ce40c9f3b224ff83ed05899eae735c9917a1b4` |
| heads | `jhlusko/OTS-homr-additonal-heads@c3d4bb0430f0516665897c618f2e971d197630cc` | `structured_heads_rareNumMixed.onnx` / `75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2` |

The service must validate the compatible-core and head-vocabulary information
in the same release's `manifest.json` before it loads the sidecar.
Verified ONNX graphs are copied from the Modal Volume into `/opt/homr` before
the supervised inference processes spawn, so inference does not retain a
runtime dependency on volume-backed links.
The image keeps `/opt/homr` first on `PYTHONPATH`, so inference imports that
patched tree and resolves the graphs beside it rather than checking the wheel's
separate `site-packages` copy.

The deployed capabilities response links to this directory at the exact
OurTextScores source commit, including the corresponding HOMR source archive
and runtime patch.

## Local text-fusion calibration preparation (2026-10-01)

Three logical routes share two physical checkpoints: lyrics/e2, directions/e4, and review-only dynamics from e4's Dynamic channel. `pins.py` distinguishes physical `DETECTORS` from logical `DETECTOR_ROUTES`/`LOGICAL_DETECTORS`. Only two models are loaded and run. DirectionText is a semantic family for legacy Tempo/StaffText/Expression labels, not a reordered training channel.

`prepare_fusion_calibration.py --workspace WORKSPACE --out OUT` preserves known positive evidence, groups same-score duplicate pixels and assigns all pages of each score to one deterministic calibration/test partition. Supply `--exclude-scores VERIFIED_TRAINING_IDS.json` once exact released-detector training identities have been recovered. Partial annotations do not establish negative truth; instrumental OSSQ establishes absence of lyrics. Oversized originals above the explicit 30MP preparation budget are deferred without changing pixels/coordinates. The output is an adjudication index, **not** a runtime calibration manifest.

`collect_fusion_calibration.py --pages OUT/calibration-pages.jsonl --models-root MODELS --out OUT/detections --device cpu --threads 2 --batch-size 2` uses the production TextDetector path on original bytes with exact pinned model hashes, no resized input. It verifies input and implementation identities on resume and truncates only incomplete final writes. The provider's connected-component postprocessing differs from older evaluation scripts: do not reuse their raw confidence tables. `build_fusion_review.py --detections OUT/detections/detections.jsonl --out OUT/review` generates an original-page overlay preview for calibration-only records.

Adjudicate unknown predictions/overlaps and freeze region matching and selection criteria before fitting calibration or examining test predictions. Independently prove detector-training exclusions before calling the test partition independent. The immutable lyrics-only manifest cannot be repurposed. No fusion-v1 manifest is supplied by these preparation scripts. Automatic dynamics remains prohibited even with a calibrated score. C1 read/verse/note attachment and final-path latency remain separate release gates. Scanner fusion responses require three logical pin expectations, including `SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_REVISION` and `SCANNER_EXPECTED_OTS_HOMR_DYNAMICS_SHA256` (currently equal e4).
