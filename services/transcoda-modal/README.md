# Transcoda Modal provider

This is the Phase A GPU provider for Scanner dual-engine recognition. It serves
one authenticated `POST /v1/scan-page` endpoint from a scale-to-zero Modal L4
container. The endpoint returns canonical kern and music21-converted MusicXML
using the strict `ots-transcoda-provider.v1` envelope.

The deployment pins the CUDA base by digest, Transcoda by commit, the Hugging
Face model repository by revision, and the exact Lightning checkpoint by
SHA-256. The ConvNeXt bootstrap that Transcoda constructs before applying the
checkpoint is also baked at a pinned Hugging Face revision and verified by
SHA-256; runtime Hugging Face access is forced offline. Dependencies are exported
with hashes from Transcoda's committed `uv.lock`. The provider verifies both
model artifacts again at runtime before it can become ready.

The model generates the body used by its training targets. After decoding, the
provider follows the upstream inference path by adding the `**kern` header and
terminal `*-` records. It converts that canonical document with music21 and
removes music21's simple external DOCTYPE; active or multiple DTD declarations
are rejected.

## Deploy

The full build, deployment, authentication, provenance, smoke-test, rollback,
and troubleshooting procedure is in
[`docs/SCANNER_TRANSCODA_MODAL_RUNBOOK.md`](../../docs/SCANNER_TRANSCODA_MODAL_RUNBOOK.md).
From this directory, with the Modal CLI authenticated, the condensed command is:

```bash
modal deploy modal_app.py
```

Create and authorize a Modal proxy token, then configure the backend's
`SCANNER_TRANSCODA_*` URL, credentials, and expected provenance pins from
`GET /v1/capabilities`. In particular, use `torch.cuda` for the expected
execution provider. Worker orchestration remains disabled until Phase B.

The reported `containerImageDigest` is a SHA-256 over every immutable Modal
build input and the exact provider/deployment source. Modal does not expose an
OCI registry manifest digest inside the function, so capabilities discloses
`containerIdentityKind: modal-build-manifest-sha256` explicitly.

The timeout ladder is 120 s readiness wait + 450 s inference < 600 s backend
timeout < 660 s Modal timeout. Keep it ordered when changing any limit.
