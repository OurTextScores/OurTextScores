# HOMR Modal provider

This is the GPU provider for the opt-in OurTextScores Scanner pilot. It deploys
an authenticated FastAPI endpoint on one Modal L4 container, scales to zero,
and pins HOMR to commit `1ddc6fcc26c4baa746eaffbba7f5e01429063465`.

`modal_app.py` describes only the deployment. The request handling, validation,
idempotency, health, provenance, and error taxonomy come from the shared
`../homr-provider` package, which is copied into the image. Keeping one
implementation is deliberate: as separate copies, this provider drifted from the
CPU one and returned a missing `CUDAExecutionProvider` as HTTP `422`, which OTS
classifies as a non-retryable bad page.

The endpoint accepts one PNG/JPEG page at `POST /v1/scan-page`. PDF splitting,
durable jobs, retries, quotas, result storage, PDF rendering, and user
notifications remain in the OurTextScores backend.

## Deploy

Full operational runbook, including the OTS-side wiring, the budget drill, and
the Phase 0 benchmark queries: [`docs/SCANNER_MODAL_RUNBOOK.md`](../../docs/SCANNER_MODAL_RUNBOOK.md).
The condensed version:

1. Create a Modal workspace and set its hard monthly budget in the Modal
   dashboard. Test the budget-exhaustion behavior with a small staging budget
   before setting the pilot budget to $30.
2. Install and authenticate the CLI. It is a standalone tool and most systems
   now ship a PEP 668 "externally managed" Python, so install it in its own
   environment: `pipx install 'modal>=1.2,<2'` (or `uv tool install`), then
   `modal setup`. Verified against CLI 1.5.3.
3. From a clean, committed OTS checkout, export
   `OTS_SOURCE_COMMIT=$(git rev-parse HEAD)` and deploy with
   `modal deploy modal_app.py`. Configure OTS with the same value as
   `SCANNER_EXPECTED_PROVIDER_SOURCE_COMMIT`; scans fail closed if it differs.
4. Create a proxy token with `modal workspace proxy-tokens create`. If your
   workspace uses environments, authorise it with
   `modal workspace proxy-tokens allow <token-id> --environment <name>`.
5. Configure the backend with the emitted URL plus
   `SCANNER_MODAL_TOKEN_ID`/`SCANNER_MODAL_TOKEN_SECRET`. Do not expose these
   credentials to the browser.

The web function uses Modal proxy authentication. The backend sends the token
using Modal's `Modal-Key` and `Modal-Secret` headers (and the combined bearer
form for compatibility with Modal endpoint tooling).

## Operational notes

- `max_containers=1` and `max_inputs=1` make pilot GPU spending and concurrency
  predictable. `min_containers=0` permits scale-to-zero.
- HOMR runs in one long-lived child process that keeps its ONNX sessions warm
  across pages. A page exceeding the hard timeout causes that child to be killed
  and replaced, so a wedged native call cannot survive into the next request.
- The timeout ladder must stay ordered so an abandoned page never keeps billing
  GPU time: hard timeout 540 s < OTS `SCANNER_PROVIDER_TIMEOUT_MS` 600 s <
  Modal function timeout 660 s. Change one and change the others.
- Successful idempotency results are cached within a warm container. The OTS
  worker also persists successful page locators, so lease recovery does not
  repeat completed pages. The provider cache intentionally does not persist
  score content after scale-down.
- `GET /readyz` fails if ONNX Runtime does not expose `CUDAExecutionProvider`,
  if a pinned model hash does not match, or before the startup warm-up inference
  has succeeded. `GET /healthz` is liveness only. Never gate traffic on
  `/healthz`.
- After the first deploy, read the model hashes from `/v1/capabilities` and set
  `HOMR_EXPECTED_SEGMENTATION_SHA256`, `HOMR_EXPECTED_ENCODER_SHA256`, and
  `HOMR_EXPECTED_DECODER_SHA256` so a changed weight file fails readiness.
- Still open against design section 9.5: no SBOM is generated for this image
  (the CI workflow scans the CPU image, which shares everything but the CUDA
  base and the `gpu` extra), and Modal runs the container as root. The CUDA base
  is digest-pinned and dependencies are hash-verified from the lockfile.
- The provider source and HOMR are AGPL-3.0. This directory and
  `../homr-provider` must remain publicly available with the deployed service's
  corresponding source and deployment instructions.
