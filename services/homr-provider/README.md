# Shared HOMR provider

`homr_engine.py` and `homr_provider.py` implement the whole Scanner page
inference contract. The two deployments — `../homr-cpu` (local development and
benchmarks) and `../homr-modal` (the L4 pilot) — differ only in their execution
provider and defaults. Keeping one implementation is deliberate: when the two
were separate copies, the GPU one drifted and reported a missing CUDA execution
provider as an unrecognisable page, which OTS classifies as non-retryable.

## Warm inference child

HOMR caches its ONNX sessions in process-level globals, so a fresh `homr`
process per page discards every warm session. `HomrEngine` keeps one long-lived
child process that owns those sessions and answers one request at a time. The
parent supervises it: an `asyncio` timeout cannot interrupt native ONNX/OpenCV
work, so a page that exceeds the hard timeout causes the child to be killed and
replaced on the next request.

## Health, readiness, warm-up

- `GET /healthz` — liveness only. The HTTP process is running.
- `GET /readyz` — the child is alive, the expected execution provider is
  present, any pinned model SHA-256 matches, and the startup warm-up inference
  has completed. Container health checks and `depends_on` must use this.
- `GET /v1/capabilities` — service and HOMR revisions, model identities and
  hashes, limits, effective ONNX providers, source URL, and licences.

Warm-up runs one real inference over `warmup-page.png` so readiness implies a
working pipeline rather than merely a loaded process. That fixture is
`warmup-page.musicxml` — a four-bar C major scale written for this purpose —
engraved with MuseScore and scaled to the 1,920 px working width. HOMR
recognises it (4 measures, 12 notes), so segmentation, staff detection, and
transformer decoding are all exercised, and it carries no third-party rights.

Regenerate it with:

```
xvfb-run -a musescore4 -o warmup.png warmup-page.musicxml   # in the OTS backend image
# then scale the result to 1920 px wide and save as warmup-page.png
```

If the fixture is missing, the engine falls back to a crude generated staff.
That usually yields no staff — the ONNX stack is still proven, so the service
reports ready and records `degradedReason` rather than refusing all traffic,
but the transformer is not warmed in that case.

## Timeout ladder

The provider must give up before its caller does, or an abandoned page keeps
billing compute after OTS has already classified the call as failed. A cold
request may spend the readiness wait *and then* the hard timeout, so it is their
sum that has to fit:

```
ready wait + hard timeout  <  OTS SCANNER_PROVIDER_TIMEOUT_MS  <  platform timeout
```

Modal ships 150 + 400 < 600 < 660. The local CPU provider ships 300 + 1500
against the 1860 s worker timeout set in `docker-compose.scanner-local.yml`.

`/v1/scan-page` waits up to the readiness deadline for a cold container to warm
rather than refusing immediately: Modal scales to zero, and a 503 there would be
retried by the caller inside the same warm-up window. A warm-up attempt that
completes *without* becoming ready — no CUDA, a bad model pin — ends the wait
straight away rather than sitting on the deadline.

## Error taxonomy

Status codes are the contract; OTS derives its entire retry classification from
them. `inference_failed` is `500`, never `422`: a 4xx tells OTS the page itself
is at fault and must not be retried, which would hide infrastructure faults as
bad pages. Failure detail is logged under `requestId` and never returned.

| Code | HTTP | Meaning |
|---|---:|---|
| `invalid_media_type` | 415 | not a supported image |
| `image_too_large` | 413 | bytes exceeded |
| `invalid_image` | 422 | decode failed or magic bytes did not match |
| `no_staff_detected` | 422 | valid image, no usable notation |
| `invalid_option` | 400 | bad idempotency key, or key reused for other input |
| `busy` | 429 | another page is in flight |
| `model_not_ready` | 503 | cold start, failed warm-up, or provenance mismatch |
| `inference_timeout` | 504 | hard page timeout; the child was replaced |
| `inference_failed` | 500 | unexpected HOMR or provider failure |

## Supply chain

Dependencies are resolved from HOMR's committed `poetry.lock` and installed with
`pip --require-hashes`, so every artifact is verified against the lockfile hash.
`poetry install` is deliberately not used: it introspects the environment, which
fails on interpreters whose bundled pip records a build-time wheel path — Modal's
`add_python` is one. HOMR itself is installed `--no-deps` from the commit-pinned
checkout, and poetry is uninstalled afterwards so it is not in the runtime image.

`HomrEngine` reports the SHA-256 of the segmentation, encoder, and decoder
weights it actually loaded. Capture them from `/v1/capabilities` after the first
build and pin them (`HOMR_EXPECTED_SEGMENTATION_SHA256` and friends) so a
silently changed weight file fails readiness instead of altering results.

## Tests

`test_homr_provider.py` covers the HTTP contract with the engine faked, so it
needs no models or GPU. Run it inside the CPU image:

```
npm run scanner:local:up
npm run scanner:provider:test
```
