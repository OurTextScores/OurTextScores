# OTS-HOMR Modal provider source inputs

This directory is the reproducible input set for the dedicated OTS-HOMR GPU
provider. It is intentionally separate from `services/homr-modal`: upstream
HOMR must remain independently deployable.

## Pinned runtime source

The rareNum core and structured-head sidecar were produced from upstream HOMR
commit `997b70a88c9f945b632f4129b036b2cd0972b2a3` plus
`patches/homr-997-runtime.patch`.

The patch is restricted to the seven inference/runtime files required for the
rareNum and structured-head paths. It deliberately excludes training and corpus
changes from the source instance. Its SHA-256 is:

```text
7a471b6610e4237749c251dfb7a397e7fccfa0e5b3eaf59db2c2203943bc49e1
```

The eventual Modal image must clone that exact commit, verify it, apply this
patch with `git apply --check` followed by `git apply`, and fail the build if
the resulting tree differs from the patch input.

## Pinned private model inputs

| Role | Private repository / revision | File / SHA-256 |
| --- | --- | --- |
| core | `jhlusko/OTS-homr@1dbc87399c70238136da0dfd412fff032d17b76c` | `encoder.onnx` / `f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1`; `decoder.onnx` / `7abc3ea71caac8f5a4fd9a96f0ce40c9f3b224ff83ed05899eae735c9917a1b4` |
| heads | `jhlusko/OTS-homr-additonal-heads` | `structured_heads_rareNumMixed.onnx` / `75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2` |

The service must validate the compatible-core and head-vocabulary information
in the same release's `manifest.json` before it loads the sidecar.
