# HOMR CPU development provider

This profile-gated service runs the pinned HOMR Scanner provider locally with
ONNX Runtime's `CPUExecutionProvider`. It is not a separate implementation: the
request handling, validation, idempotency, health, provenance, and error
taxonomy all come from `../homr-provider`, so it is byte-for-byte the same
contract as the Modal provider. It is intended only for development, manual
real-HOMR smoke tests, and CPU/GPU benchmarking.

Because the shared package sits beside this directory, the Docker build context
is `./services` and the Dockerfile path is `homr-cpu/Dockerfile`.

Start the local Scanner stack with:

```bash
npm run scanner:local:up
```

The provider is reachable only through the Compose network and the host
loopback address `http://127.0.0.1:8010`. It accepts one inference at a time and
returns `429` instead of building an internal queue. The image can be large and
its first build downloads the pinned HOMR source, Python dependencies, and
model weights. CPU inference may take several minutes per page.

Readiness is `GET /readyz`, not `/healthz`: the container health check and the
worker's `depends_on` wait for the models to load and the startup warm-up
inference to succeed. `/healthz` reports liveness only. Startup therefore takes
noticeably longer than it did when a fresh `homr` process was spawned per page —
that cost has moved from every page to once per container.

Run a direct real-HOMR benchmark using a PNG or JPEG score page:

```bash
npm run scanner:local:benchmark -- /absolute/path/to/score-page.png
```

Run the browser workflow against that real page:

```bash
HOMR_REAL_FIXTURE=/absolute/path/to/score-page.png npm run scanner:local:smoke
```

Stop the profile with `npm run scanner:local:down`. This service is not a
production fallback for Modal and must not be enabled on the public VPS.

The OTS provider code is AGPL-3.0-or-later and HOMR declares AGPL-3.0. The exact
HOMR source revision, the loaded model hashes, the source URL, and both licence
identifiers are reported by `/v1/capabilities`; the revision and model hashes
also appear on every successful response.
