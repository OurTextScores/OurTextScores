# HOMR CPU development provider

This profile-gated service runs the pinned HOMR Scanner provider locally with
ONNX Runtime's `CPUExecutionProvider`. It implements the same
`POST /v1/scan-page` response and provenance contract as the Modal provider,
but it is intended only for development, manual real-HOMR smoke tests, and
CPU/GPU benchmarking.

Start the local Scanner stack with:

```bash
npm run scanner:local:up
```

The provider is reachable only through the Compose network and the host
loopback address `http://127.0.0.1:8010`. It accepts one inference at a time and
returns `429` instead of building an internal queue. The image can be large and
its first build downloads the pinned HOMR source, Python dependencies, and
model weights. CPU inference may take several minutes per page.

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
HOMR source revision is reported by `/healthz`, `/v1/capabilities`, and every
successful response.
