# Scanner: OTS-HOMR Modal provider deployment runbook

Operational procedure for deploying the private rareNum OTS-HOMR model as an
**opt-in third Scanner engine**. The existing HOMR provider remains the normal
primary engine; this runbook never changes `SCANNER_PROVIDER_URL` or its
credentials.

Design reference: `docs/private/SCANNER_OTS_HOMR_PROVIDER_DESIGN_2026-08-31.md`.

**Status:** the dedicated provider and Scanner integration live in this
repository. Complete the local verification and commit gate below before each
deployment.

**Cost and safety:** use a distinct Modal App, a distinct proxy token, and a
small staging budget. The provider gets a read-only Hugging Face token; neither
the Scanner worker nor a browser ever receives that token.

---

## 0. What is being deployed

The release comprises four private Hugging Face repositories. Pin both the
repository revision and the file SHA-256; a branch name such as `main` is not a
pin.

| Component | Repository | Immutable revision | File / SHA-256 |
| --- | --- | --- | --- |
| rareNum core | `jhlusko/OTS-homr` | `1dbc87399c70238136da0dfd412fff032d17b76c` | `OTS-homr.pth` / `1b2855ce3facea9aa8b0017f6e30143abd9aa43569a2f9ce1ab46bf8bf818fa3` |
| lyrics detector (E2) | `jhlusko/lyrics` | `1bf2201d2eead54f78d79e2beba502b204614a92` | `lyrics.pth` / `7ff21020d5fefe5b774af71dd50610d1b05011f040c4b2c9c58f249b43f39804` |
| non-lyric text detector (E4) | `jhlusko/non-lyric-text` | `9073adb53d901c90419f63b0f7e3fb4372ed18cc` | `non-lyric-text.pth` / `fcb8ca529fa355b0427112bda1c4edd95b2d6cc6c369be0c32f3313987a4ec82` |
| additional heads | `jhlusko/OTS-homr-additonal-heads` | `c3d4bb0430f0516665897c618f2e971d197630cc` | `OTS-homr-additonal-heads.pth` / `f6edb17ada2616b94330d8a20cff73e9e1e2a9cd77a8348b8543fde722552650` |

The additional-head manifest is at the same revision. Its current byte SHA-256
is `7f92b9b948e6a39daef1f8bcdb66c8ebdfed2c38024ad532f292e0b4d04781fa`;
it declares `structured_heads_rareNumMixed.onnx` with SHA-256
`75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2`.

The creation UI exposes one text-detector policy. Additional-head inference is
always run and produces a second retained MusicXML candidate:

| Option | Meaning |
| --- | --- |
| Text detector: `lyrics` | E2 lyrics detector. |
| Text detector: `non-lyric-text` | E4, comparison/experimental choice. |
| Text detector: `none` | Diagnostic mode. |

After recognition, the review page independently selects any combination of
`beam`, `advance` (shown as rhythmic spacing), `stem`, `tie`, and `slur`.
Selecting none uses core output. Selecting all reuses the retained
additional-heads MusicXML. Any proper subset is regenerated from retained token
proposals without rerunning detector, encoder, decoder, or head inference.
Dynamic predictions remain diagnostic evidence and can never be selected or
emitted.

---

## 1. Prerequisites

- A clean, committed OurTextScores checkout containing the provider service
  directory once implemented. Deploy from the repository root: Modal's image
  build must include provider source and its exact release pins.
- A dedicated Modal workspace or a verified budget boundary. Set a deliberately
  small staging budget before the first GPU request.
- Modal CLI, authenticated to the intended environment:

  ```bash
  uv tool install 'modal==1.5.3'
  modal --version
  modal setup
  export MODAL_ENVIRONMENT=main
  modal environment list
  ```

- A Hugging Face **read** token with access only to the four private model
  repositories. Store it as a Modal secret named, for example,
  `ots-homr-hf-read`; do not place it in `.env`, application containers, or
  shell history.
- The provider implementation must meet the contract in §3 and its focused
  tests must pass before deployment.

---

## 2. Pre-deployment checks

Run from the repository root:

```bash
test -z "$(git status --porcelain)" || {
  echo 'Refusing to deploy a dirty checkout' >&2
  exit 1
}

export OTS_SOURCE_COMMIT="$(git rev-parse HEAD)"
printf '%s\n' "$OTS_SOURCE_COMMIT"
test -f services/ots-homr-modal/modal_app.py
test -f services/ots-homr-modal/ots_homr_provider.py
test -f services/ots-homr-modal/source/homr-997b70-source.tar.gz
printf '%s  %s\n' \
  819eca26f26e977e2a376d03c8aa4ddaf1f631db69a87ccc9d1ad943f75b4de9 \
  services/ots-homr-modal/source/homr-997b70-source.tar.gz | sha256sum --check --strict
printf '%s  %s\n' \
  4970d1eeaedce7a5444ff70764a8662b1f0a6d47c0f564073342628048245898 \
  services/ots-homr-modal/patches/homr-997-runtime.patch | sha256sum --check --strict

uv run \
  --with fastapi==0.116.1 \
  --with httpx==0.28.1 \
  --with python-multipart==0.0.30 \
  env PYTHONPATH=services/homr-provider:services/ots-homr-modal \
  python -m unittest discover -s services/ots-homr-modal -p 'test_*.py'
```

These checks are an implementation gate; do not substitute the upstream HOMR
provider or its model endpoint.

Before deploying, verify the private release pins from a machine holding a
read-only HF token. The following prints only public identifiers and hashes,
never the token:

```bash
python3 - <<'PY'
import hashlib
import os
from huggingface_hub import HfApi, hf_hub_download

repos = {
    'OTS-homr': ('1dbc87399c70238136da0dfd412fff032d17b76c', 'OTS-homr.pth'),
    'lyrics': ('1bf2201d2eead54f78d79e2beba502b204614a92', 'lyrics.pth'),
    'non-lyric-text': ('9073adb53d901c90419f63b0f7e3fb4372ed18cc', 'non-lyric-text.pth'),
    'OTS-homr-additonal-heads': ('c3d4bb0430f0516665897c618f2e971d197630cc', 'OTS-homr-additonal-heads.pth'),
}
api = HfApi(token=os.environ['HF_TOKEN'])
for repo, (revision, filename) in repos.items():
    info = api.model_info(f'jhlusko/{repo}', revision=revision)
    assert info.sha == revision, (repo, info.sha)
    path = hf_hub_download(f'jhlusko/{repo}', filename, revision=revision,
                           token=os.environ['HF_TOKEN'])
    print(repo, revision, filename, hashlib.sha256(open(path, 'rb').read()).hexdigest())
PY
```

If a hash differs, treat it as a release incident. Do not update an expected
hash just to make a deployment proceed.

The image installs the archived HOMR package with
`POETRY_DYNAMIC_VERSIONING_BYPASS=0.0.0`. This is required because the exact
source archive intentionally contains no `.git` directory; removing the
override makes `poetry-dynamic-versioning` fail during package metadata
generation.

---

## 3. Provider contract that must exist before deployment

The OTS backend adapter calls an authenticated `POST /v1/scan-page` with:

```text
multipart field: page
multipart fields: detectTitle, textDetector
header: Idempotency-Key
```

The provider must return `ots-ots-homr-provider.v2` and a response shaped like:

```json
{
  "schemaVersion": "ots-ots-homr-provider.v2",
  "requestId": "...",
  "inputSha256": "<sha256 of page bytes>",
  "engine": {
    "name": "ots-homr",
    "serviceRevision": "ots-ots-homr-provider-v3",
    "core": { "repository": "jhlusko/OTS-homr", "revision": "...", "sha256": "..." },
    "textDetector": { "id": "lyrics", "revision": "...", "sha256": "..." },
    "structuredHeads": {
      "mode": "both",
      "revision": "...",
      "sha256": "...",
      "manifestSha256": "...",
      "compatibleCoreRevision": "...",
      "emittedHeadFamilies": ["beam.level", "advance.delta", "stem.direction", "tie", "slur"]
    },
    "executionProvider": "CUDAExecutionProvider"
  },
  "result": {
    "selectedCandidate": "core",
    "candidates": {
      "core": { "musicXmlBase64": "...", "musicXmlSha256": "...", "review": { "staves": [] } },
      "additional-heads": { "musicXmlBase64": "...", "musicXmlSha256": "...", "review": { "staves": [] } }
    }
  },
  "timing": { "inferenceMs": 0 }
}
```

Required routes are `/healthz`, `/readyz`, `/v1/capabilities`, and
`/v1/scan-page`, `/v1/regenerate` for reviewed token corrections, and
`/v1/materialize-structured` for a selected head-family subset, all behind
Modal proxy auth. The first scan request must wait for the same guarded
warm-up as `/readyz`; returning `model_not_ready` while a cold-start warm-up is
still in progress exhausts the Scanner worker's retries before the model can
become ready. `/readyz` must remain false until
all selected model components have been downloaded at their exact revision,
their SHA-256 values match, the compatibility manifest matches the rareNum
core, and a genuine GPU warm-up has succeeded. Set Hugging Face offline mode
after this preparation; inference must not download a mutable release.

The materialization route accepts the retained `title`, six-field `staves`, a
parallel `structured` proposal array, and a unique subset of the five allowed
families. It performs MusicXML generation only; no model inference. The
provider must reject invalid selections and must reject rather than omit a
prohibited dynamic output. It may not report a CPU backend as CUDA.

---

## 4. Build and deploy the provider

After the service exists, deploy it from the clean checkout:

```bash
cd services/ots-homr-modal
export OTS_SOURCE_COMMIT="$(git -C ../.. rev-parse HEAD)"
modal deploy modal_app.py
```

Record the printed web-function URL as `OTS_HOMR_MODAL_URL`. Keep
`OTS_SOURCE_COMMIT` in deployment inventory with the provider service revision.
The Modal image should download the pinned snapshots while building or warming
up, validate the exact SHA-256 values in §0, then disable network model lookup.

Use one L4 (or explicitly documented equivalent), `max_containers=1`,
`max_inputs=1`, and `min_containers=0` for the initial beta. Keep the provider
function timeout at 660 seconds. Each decode has a 280-second hard limit;
the two serial core/additional-head decodes therefore remain below
`SCANNER_OTS_HOMR_PROVIDER_TIMEOUT_MS` (default 600 seconds), with 40 seconds
reserved for detector and HTTP overhead.

---

## 5. Create a dedicated proxy token

```bash
modal workspace proxy-tokens create
modal workspace proxy-tokens list
```

Store the resulting `wk-...` ID and `ws-...` secret only in deployment secret
storage. If the token is environment-scoped, allow it for the intended
environment:

```bash
modal workspace proxy-tokens allow <token-id> --environment "$MODAL_ENVIRONMENT"
```

Never reuse the existing HOMR or Transcoda token. Never expose this token to the
frontend or in a bug report.

---

## 6. Verify provider authentication and provenance

```bash
export OTS_HOMR_MODAL_URL='https://<deployment>.modal.run'
OTS_HOMR_MODAL_URL="${OTS_HOMR_MODAL_URL%/}"
read -r -p 'OTS-HOMR Modal token ID: ' SCANNER_OTS_HOMR_MODAL_TOKEN_ID
read -r -s -p 'OTS-HOMR Modal token secret: ' SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET
echo
export SCANNER_OTS_HOMR_MODAL_TOKEN_ID SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET

OTS_HOMR_AUTH=(
  -H "Modal-Key: $SCANNER_OTS_HOMR_MODAL_TOKEN_ID"
  -H "Modal-Secret: $SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET"
)

curl -sS -o /dev/null -w 'unauthenticated: HTTP %{http_code}\n' \
  "$OTS_HOMR_MODAL_URL/healthz"              # expect 401
curl --fail-with-body -sS "${OTS_HOMR_AUTH[@]}" \
  "$OTS_HOMR_MODAL_URL/healthz" | python3 -m json.tool
```

Poll readiness before sending a score:

```bash
for attempt in $(seq 1 150); do
  status=$(curl -sS -o /tmp/ots-homr-ready.json -w '%{http_code}' \
    "${OTS_HOMR_AUTH[@]}" "$OTS_HOMR_MODAL_URL/readyz")
  [ "$status" = 200 ] && break
  printf 'ready attempt %s: HTTP %s\n' "$attempt" "$status"
  sleep 5
done
test "$status" = 200
python3 -m json.tool /tmp/ots-homr-ready.json
```

Fetch capabilities and confirm every identity before wiring Scanner:

```bash
curl --fail-with-body -sS "${OTS_HOMR_AUTH[@]}" \
  "$OTS_HOMR_MODAL_URL/v1/capabilities" > /tmp/ots-homr-capabilities.json
python3 - <<'PY'
import json, re
from pathlib import Path

c = json.loads(Path('/tmp/ots-homr-capabilities.json').read_text())
assert c['schemaVersion'] == 'ots-ots-homr-provider.v2'
assert c['engine'] == 'ots-homr'
assert re.fullmatch(r'[a-f0-9]{40}', c['providerSourceCommit'])
assert c['providerSource'].endswith('/services/ots-homr-modal')
assert c['core']['repository'] == 'jhlusko/OTS-homr'
assert c['core']['revision'] == '1dbc87399c70238136da0dfd412fff032d17b76c'
assert c['core']['sha256'] == '1b2855ce3facea9aa8b0017f6e30143abd9aa43569a2f9ce1ab46bf8bf818fa3'
assert c['core']['runtimeArtifacts']['encoderOnnxSha256'] == 'f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1'
assert c['core']['runtimeArtifacts']['decoderOnnxSha256'] == '7abc3ea71caac8f5a4fd9a96f0ce40c9f3b224ff83ed05899eae735c9917a1b4'
assert c['executionProvider'] == 'CUDAExecutionProvider'
assert c['outputCandidates'] == ['core', 'additional-heads']
assert set(c['allowedStructuredFamilies']) == {'beam', 'advance', 'stem', 'tie', 'slur'}
assert 'dynamic' not in c['allowedStructuredFamilies']
assert c['structuredHeads']['revision'] == 'c3d4bb0430f0516665897c618f2e971d197630cc'
assert c['structuredHeads']['sha256'] == 'f6edb17ada2616b94330d8a20cff73e9e1e2a9cd77a8348b8543fde722552650'
assert c['structuredHeads']['runtimeArtifacts']['onnxSha256'] == '75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2'
for detector in c['textDetectors']:
    assert detector['id'] in {'lyrics', 'non-lyric-text'}
    assert re.fullmatch(r'[a-f0-9]{40}', detector['revision'])
    assert re.fullmatch(r'[a-f0-9]{64}', detector['sha256'])
print('OTS-HOMR capabilities verified')
PY
```

If any assertion fails, stop. Fix or redeploy the provider; do not weaken the
backend pins.

---

## 7. Run one authenticated provider inference

Use the OTS-owned warm-up image, not a user score:

```bash
smoke_page=services/homr-provider/warmup-page.png
idempotency_key=$(sha256sum "$smoke_page" | awk '{print $1}')

curl --fail-with-body -sS --max-time 590 "${OTS_HOMR_AUTH[@]}" \
  -H "Idempotency-Key: $idempotency_key" \
  -H 'Accept: application/json' \
  -F "page=@${smoke_page};type=image/png" \
  -F 'detectTitle=false' \
  -F 'textDetector=lyrics' \
  "$OTS_HOMR_MODAL_URL/v1/scan-page" > /tmp/ots-homr-smoke.json
```

Verify the response and document bytes:

```bash
python3 - <<'PY'
import base64, hashlib, json
from pathlib import Path

page = Path('services/homr-provider/warmup-page.png').read_bytes()
body = json.loads(Path('/tmp/ots-homr-smoke.json').read_text())
assert body['schemaVersion'] == 'ots-ots-homr-provider.v2'
assert body['inputSha256'] == hashlib.sha256(page).hexdigest()
assert body['engine']['name'] == 'ots-homr'
assert body['engine']['textDetector']['id'] == 'lyrics'
assert body['engine']['structuredHeads']['mode'] == 'both'
assert 'dynamic.mark' not in body['engine']['structuredHeads']['emittedHeadFamilies']
assert body['result']['selectedCandidate'] == 'core'
for name in ('core', 'additional-heads'):
    candidate = body['result']['candidates'][name]
    xml = base64.b64decode(candidate['musicXmlBase64'], validate=True)
    assert hashlib.sha256(xml).hexdigest() == candidate['musicXmlSha256']
    assert b'<!DOCTYPE' not in xml.upper() and b'<!ENTITY' not in xml.upper()
    assert b'<score-partwise' in xml or b'<score-timewise' in xml
    Path(f'/tmp/ots-homr-smoke-{name}.musicxml').write_bytes(xml)
print('requestId:', body.get('requestId'))
print('inferenceMs:', body.get('timing', {}).get('inferenceMs'))
PY
```

A valid response only proves the contract. Before broadening access, inspect
both MusicXML candidates, compare them with HOMR, and test representative
single-family and mixed-family selections through Scanner.

---

## 8. Configure Scanner after verification

Store the following in the worker environment (or `/opt/ourtextscores/.env` on
the VPS). Do not put the proxy token in the frontend environment.

```dotenv
SCANNER_OTS_HOMR_ENABLED=true
SCANNER_OTS_HOMR_PROVIDER_KIND=modal
SCANNER_OTS_HOMR_PROVIDER_URL=<OTS_HOMR_MODAL_URL>
SCANNER_OTS_HOMR_MODAL_TOKEN_ID=<wk-...>
SCANNER_OTS_HOMR_MODAL_TOKEN_SECRET=<ws-...>
SCANNER_OTS_HOMR_PROVIDER_BUDGET_EXHAUSTED=false

SCANNER_EXPECTED_OTS_HOMR_PROVIDER_REVISION=ots-ots-homr-provider-v3
SCANNER_EXPECTED_OTS_HOMR_CORE_REPOSITORY=jhlusko/OTS-homr
SCANNER_EXPECTED_OTS_HOMR_CORE_REVISION=1dbc87399c70238136da0dfd412fff032d17b76c
SCANNER_EXPECTED_OTS_HOMR_CORE_SHA256=1b2855ce3facea9aa8b0017f6e30143abd9aa43569a2f9ce1ab46bf8bf818fa3
SCANNER_EXPECTED_OTS_HOMR_EXECUTION_PROVIDER=CUDAExecutionProvider

SCANNER_EXPECTED_OTS_HOMR_LYRICS_REVISION=1bf2201d2eead54f78d79e2beba502b204614a92
SCANNER_EXPECTED_OTS_HOMR_LYRICS_SHA256=7ff21020d5fefe5b774af71dd50610d1b05011f040c4b2c9c58f249b43f39804
SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_REVISION=9073adb53d901c90419f63b0f7e3fb4372ed18cc
SCANNER_EXPECTED_OTS_HOMR_NON_LYRIC_TEXT_SHA256=fcb8ca529fa355b0427112bda1c4edd95b2d6cc6c369be0c32f3313987a4ec82

SCANNER_EXPECTED_OTS_HOMR_HEADS_REVISION=c3d4bb0430f0516665897c618f2e971d197630cc
SCANNER_EXPECTED_OTS_HOMR_HEADS_SHA256=f6edb17ada2616b94330d8a20cff73e9e1e2a9cd77a8348b8543fde722552650
SCANNER_EXPECTED_OTS_HOMR_HEADS_MANIFEST_SHA256=7f92b9b948e6a39daef1f8bcdb66c8ebdfed2c38024ad532f292e0b4d04781fa

SCANNER_OTS_HOMR_PROVIDER_TIMEOUT_MS=600000
SCANNER_OTS_HOMR_MAX_PROVIDER_RESPONSE_BYTES=33554432
```

The API container also needs `SCANNER_OTS_HOMR_ENABLED=true`; it needs no
provider credentials. The repository Compose file passes the gate to the API
and loads all worker values from `.env`. For a hand-maintained VPS Compose file,
add the gate to `backend` and use `env_file: .env` for `scanner_worker`.

Recreate the API and scanner worker after changing the flag:

```bash
docker compose --profile scanner up -d --force-recreate backend scanner_worker
```

Create a Scanner job and select OTS-HOMR as the provider. Optionally choose one
other provider in the comparison dropdown. Then verify in the authenticated job
response that:

- `enginePlan.engineIds` contains the one or two providers selected by the user;
- `primaryEngineId` is the provider selected in the required dropdown;
- `enginePlan.engineOptions["ots-homr"]` records the selected text detector;
- `pages[].engines["ots-homr"]` has independent status, provenance, and
  artifacts;
- `pages[].engines["ots-homr"]` exposes the five available structured families
  and defaults to an empty selected-family list;
- selecting families invalidates the prior PDF, queues reassembly, and updates
  the effective OTS-HOMR MusicXML without issuing another scan request;
- both successful review-capable engines have their own uncertainty section;
- a failed selected provider remains visible with its error and retry action;
- a failure in OTS-HOMR does not discard a successful HOMR result.

---

## 9. Routine operation, rollback, and failure signatures

Tail the dedicated App rather than the existing HOMR App:

```bash
modal app logs ourtextscores-ots-homr-scanner \
  --env "$MODAL_ENVIRONMENT" --follow --timestamps
modal app history ourtextscores-ots-homr-scanner --env "$MODAL_ENVIRONMENT"
```

The fast application rollback is independent of Modal:

```dotenv
SCANNER_OTS_HOMR_ENABLED=false
```

Recreate the API and worker. Existing OTS-HOMR artifacts remain readable under
normal retention; new jobs cannot request it. For a provider incident, also
revoke its dedicated proxy token or stop only the OTS-HOMR Modal App.

| Symptom | Meaning / response |
| --- | --- |
| `provider_not_configured` | A required URL, pin, or selected-component pin is missing. Populate it; do not use empty defaults. |
| `provider_model_revision_mismatch` or `provider_model_artifact_mismatch` | Modal service does not match the pinned private release. Stop the engine and redeploy/repin deliberately. |
| `provider_execution_provider_mismatch` | Provider was not actually using CUDA. Treat as a deployment failure. |
| `provider_invalid_response` | Invalid envelope, digest, MusicXML, selected policy, head compatibility, or prohibited dynamics. Inspect provider logs. |
| `provider_timeout` / `provider_unavailable` | Check cold-start, Modal capacity, and timeout ladder before retrying. |
| Scanner says engine unavailable | Confirm `SCANNER_OTS_HOMR_ENABLED=true` reaches the API process and OTS-HOMR appears in the provider dropdowns. |

Every new Scanner job must select one enabled provider and may select one distinct
comparison provider. The comparison card appears only for two-provider jobs.
OTS-HOMR incurs a provider call only when it is selected.
