# Scanner Transcoda Modal build and deployment runbook

Operational procedure for building, deploying, verifying, and rolling back the
Transcoda GPU provider defined in `services/transcoda-modal/modal_app.py`.

This is the Phase A provider only. Deploying it does **not** make Scanner run a
second engine: the backend adapter is registered but the worker does not invoke
it until Phase B adds independent Transcoda orchestration. Do not replace the
live HOMR `SCANNER_PROVIDER_URL` with this endpoint.

Allow 60–90 minutes for the first build and cold-start smoke test. Subsequent
deployments normally reuse Modal's image-layer cache.

---

## 0. What Modal builds

There is no local Docker build and no image to push to a registry. `modal deploy`
builds the image layers referenced by the App, then atomically deploys the web
Function. A failed image build leaves the existing deployed version unchanged.

The App is named `ourtextscores-transcoda-scanner` and contains one authenticated
ASGI Function with:

- one NVIDIA L4 GPU;
- `min_containers=0`, so idle deployments scale to zero;
- `max_containers=1` and `max_inputs=1`, giving one page in flight;
- a 60-second scale-down window;
- a 660-second Modal timeout around a 120-second readiness wait plus a
  450-second provider inference timeout.

The build is intentionally self-contained and immutable:

| Input | Pin |
|---|---|
| CUDA base | `sha256:17e2934e1fa96152b14f78078bfbafd0f00f391df995dc6c641a720fce1202bb` |
| Transcoda source | `82041ceec62352a040d068e1a279688cf13bb237` |
| Transcoda model repository | `b529f8aa5d996d9224df3395b5b92d0867343c91` |
| Transcoda Lightning checkpoint | `3ce7387b94776cd0edc4e5b70fbc2e28ac0f4c812d5f978d1ef26e236dccdafc` |
| ConvNeXt bootstrap repository | `9cba4896e97bb86b1eb609e482a2149d84f345bc` |
| ConvNeXt `model.safetensors` | `b33653bb8c060f6dee6438f18c559dcf3258bf86cc906490daaca89bc0c39fb7` |
| Dependency resolver | uv `0.11.18` |
| Converter | music21 `9.9.1` |
| Provider contract | `ots-transcoda-modal-v1` / `ots-transcoda-provider.v1` |

Transcoda constructs the ConvNeXt base before loading the Lightning checkpoint,
even though the checkpoint then overwrites those weights. The build therefore
bakes that base at the pinned revision and the runtime redirects Transcoda to the
local snapshot. `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` make an accidental
cold-start download fail rather than follow a mutable Hugging Face branch.

### Build-manifest identity

The response field named `containerImageDigest` is a SHA-256 build-manifest
identity, not an OCI registry digest—Modal does not expose an OCI digest inside
the Function. It covers the base/model pins, OTS source commit, deployment code,
shared provider code, license/readme files, and warm-up page. Capabilities states
this explicitly as `containerIdentityKind: modal-build-manifest-sha256`.

This makes a clean committed checkout mandatory. Deploying uncommitted code would
make the image bytes differ from the `source` link required by AGPL section 13.

---

## 1. Prerequisites

- A clean, committed OurTextScores checkout containing both
  `services/transcoda-modal` and `services/transcoda-provider`.
- Access to the intended Modal workspace and environment.
- Permission to deploy Apps, create proxy tokens, view logs, and inspect billing.
- A workspace budget configured in the Modal dashboard. See
  `docs/SCANNER_MODAL_RUNBOOK.md` for the existing Scanner budget drill; a Modal
  environment is a namespace, not a separate budget boundary.
- `curl`, `python3`, Git, and either `uv` or a Python virtual environment.

Install the Modal CLI in an isolated tool environment:

```bash
uv tool install 'modal==1.5.3'
# equivalent: pipx install 'modal==1.5.3'
modal --version
modal setup
```

The commands below were verified against Modal 1.5.3. Current Modal references:

- <https://modal.com/docs/cli/latest/deploy>
- <https://modal.com/docs/guide/images>
- <https://modal.com/docs/guide/webhook-proxy-auth>
- <https://modal.com/docs/cli/latest/app>

Select the environment explicitly so a profile default cannot send the App to a
different namespace:

```bash
export MODAL_ENVIRONMENT=main
modal environment list
modal config show
```

If this is a staging deployment, use a separate environment name. If staging
must have an independent hard budget, it needs a separate workspace—the budget
is workspace-wide.

---

## 2. Pre-deployment checks

Run these from the repository root.

### 2.1 Require committed source

```bash
git status --short
test -z "$(git status --porcelain)" || {
  echo "Refusing to deploy a dirty worktree" >&2
  exit 1
}
git rev-parse HEAD
```

Record that commit. `/v1/capabilities` must later link to the same revision.

### 2.2 Run the provider contract

This exercises authentication, readiness behavior, idempotency, error mapping,
the response envelope, digest fields, and DOCTYPE refusal without a GPU:

```bash
uv run --no-project \
  --with 'fastapi==0.116.1' \
  --with 'httpx==0.28.1' \
  --with 'python-multipart==0.0.30' \
  python -m unittest discover \
    -s services/transcoda-provider -p 'test_*.py' -v
```

Expect ten passing tests.

### 2.3 Load the deployment definition locally

This does not build or deploy anything. It catches Modal SDK/API mistakes and
prints the manifest identity that this exact checkout will report:

```bash
uv run --no-project --with 'modal==1.5.3' python3 - <<'PY'
import runpy

values = runpy.run_path("services/transcoda-modal/modal_app.py")
digest = values["CONTAINER_IMAGE_DIGEST"]
assert digest.startswith("sha256:") and len(digest) == 71
print(digest)
PY
```

Do not paste this digest into production configuration yet. Re-read it from the
deployed, ready provider in step 6; that proves the running version is the one
you intended.

### 2.4 Optional independent artifact verification

The Modal build performs both checks and fails on any mismatch. To verify the
remote content independently before spending build time (about 232 MB total):

```bash
curl --fail --location --silent --show-error \
  'https://huggingface.co/btrkeks/transcoda-59M-zeroshot-v1/resolve/b529f8aa5d996d9224df3395b5b92d0867343c91/transcoda-59M-zeroshot-v1.ckpt' \
  | sha256sum

curl --fail --location --silent --show-error \
  'https://huggingface.co/facebook/convnextv2-tiny-22k-224/resolve/9cba4896e97bb86b1eb609e482a2149d84f345bc/model.safetensors' \
  | sha256sum
```

The output must match the two weight hashes in §0. Never “fix” a failed build by
blindly copying a new hash into `modal_app.py`; establish why the artifact moved.

---

## 3. Budget and environment check

Before the first request:

1. Open the Modal workspace billing/budget dashboard.
2. Confirm the hard workspace cap is enabled and has enough headroom for one L4
   cold start and smoke inference.
3. Confirm whether HOMR shares this workspace. If it does, remember both Apps
   consume the same cap.
4. Keep Phase A testing on a small staging cap until the smoke test succeeds.

Current usage can also be inspected from the CLI:

```bash
modal environment billing summary --for "this month" "$MODAL_ENVIRONMENT"
```

The budget itself is configured in the dashboard, not by `modal workspace
settings`.

---

## 4. Build and deploy

From the repository root:

```bash
deployment_tag="ots-$(git rev-parse --short HEAD)"

modal deploy \
  --env "$MODAL_ENVIRONMENT" \
  --strategy recreate \
  --tag "$deployment_tag" \
  services/transcoda-modal/modal_app.py
```

`modal deploy` automatically builds the image. The first build should visibly:

1. pull the digest-pinned CUDA base;
2. clone and detach Transcoda at the pinned commit;
3. export dependencies with hashes from Transcoda's `uv.lock`;
4. install those dependencies under `--require-hashes`;
5. download and verify the pinned ConvNeXt bootstrap;
6. download and verify the pinned Transcoda checkpoint;
7. copy the shared provider and OTS-owned warm-up page into the image.

The deployment uses `recreate` during Phase A because the App permits only one
container and the smoke test must not land on an older version. This accepts a
cold-start gap. Once live traffic exists, coordinate the backend provenance pins
with every provider deployment; a rolling window containing two different build
digests will correctly cause one side to fail closed.

Modal prints the Function URL. Record it as `TRANSCODA_MODAL_URL`; the URL is
also available in the App dashboard:

```bash
modal app list --env "$MODAL_ENVIRONMENT"
modal app history ourtextscores-transcoda-scanner --env "$MODAL_ENVIRONMENT"
modal app dashboard ourtextscores-transcoda-scanner --env "$MODAL_ENVIRONMENT"
```

Do not routinely force cache invalidation. If diagnosing a suspected bad cached
layer, `MODAL_IGNORE_CACHE=1 modal deploy ...` rebuilds from the top without
invalidating the shared cache. `MODAL_FORCE_BUILD=1` invalidates dependent image
caches and should be a last resort.

---

## 5. Create a dedicated proxy token

The Function uses `@modal.asgi_app(requires_proxy_auth=True)`. Modal rejects the
request before FastAPI unless it carries a proxy token pair.

Create a token specifically for Transcoda; do not reuse the HOMR token:

```bash
modal workspace proxy-tokens create
modal workspace proxy-tokens list
```

The command prints a token ID with a `wk-` prefix and a secret with a `ws-`
prefix. The secret is shown once. Store it in the deployment secret manager.
These are proxy credentials, not Modal API credentials (`ak-` / `as-`).

Token scope depends on the workspace:

- With RBAC enabled, newly created tokens are environment-scoped. Associate the
  token with the deployment environment:

```bash
export TRANSCODA_MODAL_TOKEN_ID='wk-...'
modal workspace proxy-tokens allow \
  "$TRANSCODA_MODAL_TOKEN_ID" "$MODAL_ENVIRONMENT"
modal workspace proxy-tokens list --environment "$MODAL_ENVIRONMENT"
```

- Without RBAC, tokens are workspace-wide and already work for Web Functions in
  every environment. Do not run `allow`: Modal will respond `Token is not
  environment-scoped`. That response does not invalidate the token; continue to
  §6. Existing workspace-wide tokens also remain workspace-wide if RBAC is later
  enabled. If environment isolation is required, enable RBAC and create a new
  scoped token rather than reusing this one.

Use dedicated Transcoda variable names when Phase B is wired:

```text
SCANNER_TRANSCODA_MODAL_TOKEN_ID
SCANNER_TRANSCODA_MODAL_TOKEN_SECRET
```

Never commit the secret, put it in the browser, or include it in diagnostic
output.

---

## 6. Verify authentication, readiness, and provenance

Load the endpoint and credentials without placing the secret directly in shell
history:

```bash
export TRANSCODA_MODAL_URL='https://<deployment>.modal.run'
# Prevent `$TRANSCODA_MODAL_URL/healthz` from becoming `//healthz` when the URL
# was copied from a source that included a trailing slash.
TRANSCODA_MODAL_URL="${TRANSCODA_MODAL_URL%/}"
export TRANSCODA_MODAL_URL
read -r -p 'Transcoda Modal token ID: ' TRANSCODA_MODAL_TOKEN_ID
read -r -s -p 'Transcoda Modal token secret: ' TRANSCODA_MODAL_TOKEN_SECRET
echo
export TRANSCODA_MODAL_TOKEN_ID TRANSCODA_MODAL_TOKEN_SECRET

TRANSCODA_AUTH=(
  -H "Modal-Key: $TRANSCODA_MODAL_TOKEN_ID"
  -H "Modal-Secret: $TRANSCODA_MODAL_TOKEN_SECRET"
)
```

First prove the endpoint is not public, then prove the token works:

```bash
curl -sS -o /dev/null -w 'unauthenticated: HTTP %{http_code}\n' \
  "$TRANSCODA_MODAL_URL/healthz"       # expect 401

curl --fail-with-body -sS --max-time 180 "${TRANSCODA_AUTH[@]}" \
  "$TRANSCODA_MODAL_URL/healthz" | python3 -m json.tool
```

`/healthz` is liveness only. Poll `/readyz` until the model has loaded and the
real warm-up inference plus music21 conversion has completed:

```bash
ready_file=/tmp/ots-transcoda-ready.json
ready_status=

for attempt in $(seq 1 150); do
  ready_status=$(curl -sS -o "$ready_file" -w '%{http_code}' \
    "${TRANSCODA_AUTH[@]}" "$TRANSCODA_MODAL_URL/readyz")
  if [ "$ready_status" = 200 ]; then
    break
  fi
  printf 'ready attempt %s: HTTP %s\n' "$attempt" "$ready_status"
  sleep 5
done

python3 -m json.tool "$ready_file"
test "$ready_status" = 200
```

Expect `ready: true`, `executionProvider: torch.cuda`, and an L4 accelerator.
If readiness fails, inspect logs before sending a page:

```bash
modal app logs ourtextscores-transcoda-scanner \
  --env "$MODAL_ENVIRONMENT" --tail 300 --timestamps
```

Capture and validate capabilities:

```bash
curl --fail-with-body -sS "${TRANSCODA_AUTH[@]}" \
  "$TRANSCODA_MODAL_URL/v1/capabilities" \
  > /tmp/ots-transcoda-capabilities.json

export EXPECTED_OTS_COMMIT="$(git rev-parse HEAD)"

python3 - <<'PY'
import json
import os
import re
from pathlib import Path

caps = json.loads(Path("/tmp/ots-transcoda-capabilities.json").read_text())
expected = {
    "schemaVersion": "ots-transcoda-provider.v1",
    "engine": "transcoda",
    "serviceRevision": "ots-transcoda-modal-v1",
    "transcodaCommit": "82041ceec62352a040d068e1a279688cf13bb237",
    "modelArtifact": "btrkeks/transcoda-59M-zeroshot-v1",
    "modelRevision": "b529f8aa5d996d9224df3395b5b92d0867343c91",
    "modelArtifactSha256": "3ce7387b94776cd0edc4e5b70fbc2e28ac0f4c812d5f978d1ef26e236dccdafc",
    "encoderArtifact": "facebook/convnextv2-tiny-22k-224",
    "encoderRevision": "9cba4896e97bb86b1eb609e482a2149d84f345bc",
    "encoderArtifactSha256": "b33653bb8c060f6dee6438f18c559dcf3258bf86cc906490daaca89bc0c39fb7",
    "containerIdentityKind": "modal-build-manifest-sha256",
    "converter": "music21",
    "converterVersion": "9.9.1",
    "executionProvider": "torch.cuda",
    "providerLicense": "AGPL-3.0-or-later",
    "transcodaLicense": "AGPL-3.0-only",
    "modelLicense": "CC-BY-4.0",
}
for key, wanted in expected.items():
    actual = caps.get(key)
    assert actual == wanted, f"{key}: expected {wanted!r}, got {actual!r}"

digest = caps.get("containerImageDigest", "")
assert re.fullmatch(r"sha256:[0-9a-f]{64}", digest), digest
assert "torch.cuda" in caps.get("availableExecutionProviders", []), caps
assert os.environ["EXPECTED_OTS_COMMIT"] in caps.get("source", ""), caps.get("source")
assert caps.get("decoding") == {
    "strategy": "greedy",
    "numBeams": 1,
    "maxLength": 2048,
    "repetitionPenalty": 1.1,
}

print("Capabilities verified")
print(f"SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST={digest}")
PY
```

This step proves the checkpoint hash, encoder bootstrap hash, installed music21
version, CUDA backend, source revision, and build-manifest identity reported by
the ready child—not merely the constants declared at deploy time.

---

## 7. Run one authenticated inference

Use the OTS-owned warm-up score already included in the image. This avoids
placing a user's scan in temporary diagnostic files:

```bash
smoke_page=services/homr-provider/warmup-page.png
idempotency_key=$(sha256sum "$smoke_page" | awk '{print $1}')

curl --fail-with-body -sS --max-time 590 \
  "${TRANSCODA_AUTH[@]}" \
  -H "Idempotency-Key: $idempotency_key" \
  -H 'Accept: application/json' \
  -F "page=@${smoke_page};type=image/png" \
  "$TRANSCODA_MODAL_URL/v1/scan-page" \
  > /tmp/ots-transcoda-smoke.json
```

Validate every digest and both returned document formats:

```bash
python3 - <<'PY'
import base64
import hashlib
import json
from pathlib import Path

page = Path("services/homr-provider/warmup-page.png").read_bytes()
body = json.loads(Path("/tmp/ots-transcoda-smoke.json").read_text())
assert body["schemaVersion"] == "ots-transcoda-provider.v1"
assert body["inputSha256"] == hashlib.sha256(page).hexdigest()
assert body["engine"]["name"] == "transcoda"
assert body["engine"]["executionProvider"] == "torch.cuda"

result = body["result"]
kern = base64.b64decode(result["kernBase64"], validate=True)
xml = base64.b64decode(result["musicXmlBase64"], validate=True)
assert hashlib.sha256(kern).hexdigest() == result["kernSha256"]
assert hashlib.sha256(xml).hexdigest() == result["musicXmlSha256"]

kern_text = kern.decode("utf-8")
records = [line for line in kern_text.splitlines() if line and not line.startswith("!!")]
assert any("**kern" in line.split("\t") for line in records if line.startswith("**"))
terminator = next(line for line in reversed(records) if line.startswith("*"))
assert all(token == "*-" for token in terminator.split("\t"))

upper_xml = xml.upper()
assert b"<!DOCTYPE" not in upper_xml
assert b"<!ENTITY" not in upper_xml
assert b"<score-partwise" in xml or b"<score-timewise" in xml
assert not result["generation"]["truncated"], result["generation"]
assert result["generation"]["strategy"] == "greedy", result["generation"]
assert result["generation"]["numBeams"] == 1, result["generation"]
assert result["generation"]["repetitionPenalty"] == 1.1, result["generation"]

Path("/tmp/ots-transcoda-smoke.krn").write_bytes(kern)
Path("/tmp/ots-transcoda-smoke.musicxml").write_bytes(xml)
print("requestId:", body["requestId"])
print("timing:", body["timing"])
print("generation:", result["generation"])
print("kern bytes:", len(kern), "MusicXML bytes:", len(xml))
PY
```

Inspect the generated files if needed. A valid envelope is necessary but not a
quality judgment; Phase B's Klengel run remains the recognition kill test.

Optionally repeat the same request immediately with the same key and confirm the
warm-container idempotency cache returns the same `requestId` without a second
inference. A replacement container has an empty cache, which is expected—the OTS
worker provides durable idempotency above it.

---

## 8. Record the Phase B handoff configuration

Store these values in the deployment inventory and secret manager. Phase B now
invokes the Transcoda adapter, but remains off until the worker flag is enabled:

```text
SCANNER_TRANSCODA_ENABLED=false
SCANNER_TRANSCODA_PROVIDER_KIND=modal
SCANNER_TRANSCODA_PROVIDER_URL=<TRANSCODA_MODAL_URL>
SCANNER_TRANSCODA_MODAL_TOKEN_ID=<wk-...>
SCANNER_TRANSCODA_MODAL_TOKEN_SECRET=<ws-...>
SCANNER_TRANSCODA_PROVIDER_BUDGET_EXHAUSTED=false

SCANNER_EXPECTED_TRANSCODA_PROVIDER_REVISION=ots-transcoda-modal-v1
SCANNER_EXPECTED_TRANSCODA_MODEL_ARTIFACT=btrkeks/transcoda-59M-zeroshot-v1
SCANNER_EXPECTED_TRANSCODA_MODEL_REVISION=b529f8aa5d996d9224df3395b5b92d0867343c91
SCANNER_EXPECTED_TRANSCODA_MODEL_SHA256=3ce7387b94776cd0edc4e5b70fbc2e28ac0f4c812d5f978d1ef26e236dccdafc
SCANNER_EXPECTED_TRANSCODA_CONTAINER_IMAGE_DIGEST=<value from capabilities>
SCANNER_EXPECTED_TRANSCODA_CONVERTER=music21
SCANNER_EXPECTED_TRANSCODA_CONVERTER_VERSION=9.9.1
SCANNER_EXPECTED_TRANSCODA_EXECUTION_PROVIDER=torch.cuda
SCANNER_TRANSCODA_PROVIDER_TIMEOUT_MS=600000
```

The container identity changes when any covered build input or OTS source commit
changes. Capture it again after every deployment. Never weaken the backend check
to avoid coordinating a rollout.

Keep the HOMR `SCANNER_PROVIDER_*` configuration untouched. The two engines need
separate URLs, credentials, state, retries, telemetry, and provenance.

After deploying a backend/worker image that contains Phase B, set
`SCANNER_TRANSCODA_ENABLED=true` in the worker environment and recreate only the
worker. The base Compose service reads these values from `.env`; a hand-maintained
VPS Compose file must pass them through explicitly if it does not use that file.
The flag is the rollback: set it back to `false` and recreate the worker. Existing
Transcoda artifacts remain downloadable until normal Scanner retention removes
them.

Run one Scanner job and inspect `pages[].engines.transcoda` in the authenticated
job response. It must reach its own terminal state without changing a successful
HOMR run into a failed page. Download the model-authored results explicitly:

```text
GET /api/scanner/jobs/<job-id>/artifacts/musicxml?page=1&engine=transcoda
GET /api/scanner/jobs/<job-id>/artifacts/kern?page=1&engine=transcoda
```

The results ZIP manifest records each engine's attempts, request/revision data,
provenance, errors, and artifact checksums without exposing object-storage keys.
Phase B adds no compare UI and performs no cross-engine merge. HOMR remains the
preferred effective page; Transcoda is only a fallback when HOMR has no usable
MusicXML.

---

## 9. Routine operations

Recent or streaming logs:

```bash
modal app logs ourtextscores-transcoda-scanner \
  --env "$MODAL_ENVIRONMENT" --tail 300 --timestamps

modal app logs ourtextscores-transcoda-scanner \
  --env "$MODAL_ENVIRONMENT" --follow --timestamps
```

Deployment history and billing:

```bash
modal app history ourtextscores-transcoda-scanner --env "$MODAL_ENVIRONMENT"
modal environment billing summary --for "this month" "$MODAL_ENVIRONMENT"
```

The first request after scale-to-zero pays for model load plus the warm-up score.
Treat its timing as a cold sample. `/healthz` may be healthy while `/readyz` is
still `503`; only readiness proves the pinned artifacts loaded and a complete
inference/conversion succeeded.

To replace containers without changing code:

```bash
modal app rollover ourtextscores-transcoda-scanner \
  --env "$MODAL_ENVIRONMENT" --strategy recreate
```

This does not change provenance; it is useful only for recovering from a bad
container or re-running cold-start diagnostics.

---

## 10. Rollback and emergency stop

Before Phase B, the safest response to a bad deployment is simply not to record
or wire its endpoint. Fix the source and redeploy from a clean commit.

If the Modal plan supports deployment rollback, inspect history and roll back to
a known version:

```bash
modal app history ourtextscores-transcoda-scanner --env "$MODAL_ENVIRONMENT"
export TRANSCODA_ROLLBACK_VERSION='v3'
modal app rollback ourtextscores-transcoda-scanner "$TRANSCODA_ROLLBACK_VERSION" \
  --env "$MODAL_ENVIRONMENT" --strategy recreate
```

After rollback, repeat §§6–7 and use the rolled-back capabilities digest. Modal
rollback is plan-dependent; source rollback plus a new deploy works everywhere.

For an active incident, revoke the Transcoda proxy token or stop the App from the
dashboard. For an RBAC-scoped token, remove only its association with this
environment:

```bash
modal workspace proxy-tokens revoke \
  "$TRANSCODA_MODAL_TOKEN_ID" "$MODAL_ENVIRONMENT"
```

For a workspace-wide token, `revoke` will report `Token is not
environment-scoped`; delete the entire token instead:

```bash
modal workspace proxy-tokens delete "$TRANSCODA_MODAL_TOKEN_ID"
```

Stopping the App is a separate, destructive option:

```bash
modal app stop ourtextscores-transcoda-scanner --env "$MODAL_ENVIRONMENT"
```

Stopping is permanent for that deployment; restoring service requires another
`modal deploy`. For a scoped token, revoking only the environment association is
more recoverable than deleting the token. Deleting a workspace-wide token
immediately affects every client and environment that uses it.

---

## 11. Failure signatures

| Symptom | Meaning / action |
|---|---|
| Build fails at `git checkout` | The pinned Transcoda commit was unavailable. Do not move to `main`; verify the repository and pin. |
| `uv ... --require-hashes` fails | Lock/artifact inconsistency or unavailable wheel. Do not install without hashes. |
| Checkpoint or encoder `sha256sum` fails | Remote bytes differ from the reviewed artifact. Stop and investigate; do not copy the new hash blindly. |
| `/healthz` returns `401` | Missing or wrong proxy-token credentials. Verify the `wk-` ID and `ws-` secret. |
| `/healthz` returns `403` | A valid RBAC-scoped token is not associated with this environment. Workspace-wide tokens need no association. |
| Authenticated `/healthz` returns `404` with `{"detail":"Not Found"}` | FastAPI was reached, but the path is wrong. Use the exact Function URL printed by `modal deploy` as `TRANSCODA_MODAL_URL`, with no path or trailing slash. |
| Authenticated `/healthz` hangs or returns `5xx` | The protected request reached Modal but its container did not start. Inspect App logs for an image or module-import failure before retrying. |
| `/healthz` returns plain-text `404` saying the workspace is disabled | Modal's workspace budget cap fired. Restore budget deliberately; do not treat it as a missing route. |
| `/readyz` stays `503 model_not_ready` | Inspect App logs. Common causes are unavailable CUDA, artifact mismatch, missing offline encoder files, converter mismatch, or failed warm-up conversion. |
| Readiness reports `torch.cpu` | Invalid deployment. The provider should fail closed rather than serve it; verify the L4 assignment. |
| Scan returns `422 invalid_image` | Multipart media type/magic bytes or image decoding failed. |
| Scan returns `422 no_staff_detected` | The image decoded but Transcoda produced no notation. This is deterministic for that page. |
| Scan returns `422 generation_failed` | Recognition returned kern but music21 could not convert it. Preserve logs and the request ID; retrying the same bytes is not useful. |
| Scan returns `422 generation_runaway` | The decoder repeated one notation/barline cycle instead of producing a score. The provider rejects this deterministic bad output even if the model emitted EOS; preserve the request ID and input digest for model-quality analysis. |
| Scan returns `429 busy` | One page is already in flight; the caller should back off. |
| Scan returns `504 inference_timeout` | The model child exceeded 450 seconds and was killed. The next request will re-warm a replacement. |
| Capabilities digest differs after a deploy | Expected whenever a covered source/build input changed. Verify source and pins, then update Phase B configuration deliberately. |
| A request sees old provenance after an update | An old container is still serving during a rolling transition. Phase A uses `--strategy recreate` to avoid this. |

Do not proceed to Phase B until authentication, readiness, capabilities, one
complete envelope, digest verification, offline model loading, and the workspace
budget behavior have all been demonstrated.
