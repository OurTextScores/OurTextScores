# HOMR Modal provider

This is the GPU provider for the opt-in OurTextScores Scanner pilot. It deploys
an authenticated FastAPI endpoint on one Modal L4 container, scales to zero,
and pins HOMR to commit `1ddc6fcc26c4baa746eaffbba7f5e01429063465`.

The endpoint accepts one PNG/JPEG page at `POST /v1/scan-page`. PDF splitting,
durable jobs, retries, quotas, result storage, PDF rendering, and user
notifications remain in the OurTextScores backend.

## Deploy

1. Create a Modal workspace and set its hard monthly budget in the Modal
   dashboard. Test the budget-exhaustion behavior with a small staging budget
   before setting the pilot budget to $30.
2. Install and authenticate the CLI: `python -m pip install -r requirements.txt`
   and `modal setup`.
3. Deploy with `modal deploy modal_app.py`.
4. Create a proxy token with `modal workspace proxy-tokens create`. If RBAC is
   enabled, authorize it for the deployment environment.
5. Configure the backend with the emitted URL plus
   `SCANNER_MODAL_TOKEN_ID`/`SCANNER_MODAL_TOKEN_SECRET`. Do not expose these
   credentials to the browser.

The web function uses Modal proxy authentication. The backend sends the token
using Modal's `Modal-Key` and `Modal-Secret` headers (and the combined bearer
form for compatibility with Modal endpoint tooling).

## Operational notes

- `max_containers=1` and `max_inputs=1` make pilot GPU spending and concurrency
  predictable. `min_containers=0` permits scale-to-zero.
- HOMR runs in a child process. A timeout kills that request's inference process
  rather than leaving a wedged session inside the API process.
- Successful idempotency results are cached within a warm container. The OTS
  worker also persists successful page locators, so lease recovery does not
  repeat completed pages. The provider cache intentionally does not persist
  score content after scale-down.
- Readiness fails if ONNX Runtime does not expose `CUDAExecutionProvider`.
- The provider source and HOMR are AGPL-3.0. This directory must remain publicly
  available with the deployed service's corresponding source and deployment
  instructions.
