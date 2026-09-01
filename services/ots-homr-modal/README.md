# OTS-HOMR Modal provider source inputs

This directory is the reproducible input set for the dedicated OTS-HOMR GPU
provider. It is intentionally separate from `services/homr-modal`: upstream
HOMR must remain independently deployable.

## Pinned runtime source

The rareNum core and structured-head sidecar were produced from upstream HOMR
commit `997b70a88c9f945b632f4129b036b2cd0972b2a3` plus
`patches/homr-997-runtime.patch`.

That commit was local to the training branch and is not reachable from upstream
GitHub. `source/homr-997b70-source.tar.gz` is therefore the immutable clean-tree
archive used by Modal. Its SHA-256 is
`819eca26f26e977e2a376d03c8aa4ddaf1f631db69a87ccc9d1ad943f75b4de9`.

The patch is restricted to the nine inference/runtime files required for the
rareNum and structured-head paths. It deliberately excludes training and corpus
changes from the source instance. Its SHA-256 is:

```text
4970d1eeaedce7a5444ff70764a8662b1f0a6d47c0f564073342628048245898
```

The Modal image verifies and extracts that archive, applies the patch with
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
