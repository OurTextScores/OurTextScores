# Scanner: Modal provider deployment runbook

Operational runbook for standing up the HOMR GPU provider on Modal and pointing
OurTextScores at it. Design reference: `docs/private/SCANNER_PAGE_HOMR_DESIGN_2026-08-06.md`
(§9 provider, §10.3 Modal, §11 benchmark, §13.5 configuration).

Publishing this alongside `services/homr-provider/` also satisfies the AGPL §13
obligation to make the deployed provider's build and deployment instructions
available (design §12.6).

**Time:** about 90 minutes, most of it waiting on the first image build.
**Cost:** the pilot is intended to sit inside Modal's $30/month included credit.
The workspace budget in step 2 is the thing that actually stops overspend.

---

## 0. Cold starts

Modal runs with `min_containers=0`, so the container is cold whenever traffic has
paused for longer than `scaledown_window` (60 s). Two things make that safe:

- **The provider waits.** `/v1/scan-page` waits up to `HOMR_READY_WAIT_SECONDS`
  (150) for warm-up to finish rather than returning `503 model_not_ready` at a
  cold container. Modal is already holding the request while the container boots,
  so this is the natural place to absorb the cold start. `/healthz` still answers
  immediately, per design §9.3.
- **The client backs off.** `scanWithRetry` waits with exponential backoff and
  equal jitter before its one retry, as design §13.1 specifies. It previously
  retried instantly, so both attempts landed inside the same warm-up window and
  the first page of every idle-period job was lost.

A warm-up attempt that *completes without becoming ready* — no CUDA, a bad model
pin — ends the wait immediately rather than sitting out the deadline, so real
faults still surface fast.

**What you will still see:** the first page after an idle period pays warm-up
time on top of its inference time. Expect it in the benchmark, and treat the
first page of a cold job as a cold sample rather than a warm one.

## 1. Prerequisites

- A Modal account with a payment method. Starter includes $30/month of usage
  credit, but Modal still bills usage beyond it — the budget in step 2 is the
  hard stop, not the credit.
- A checkout of this branch. `modal_app.py` copies `../homr-provider/` into the
  image via `add_local_dir`, so **deploy from the repo**, not from a copied file.
- Python with the Modal CLI: `python -m pip install -r services/homr-modal/requirements.txt`
- Shell access to the OTS VPS.

> **VPS reality check.** `/opt/ourtextscores` is not a git checkout, the Compose
> files there are unmanaged, and `deploy-backend.yml` only deploys the backend
> image. Every Compose and `.env` change in steps 6–7 is a **manual** edit on the
> VPS and will not arrive via CI.

---

## 2. Workspace and budget

Do this before deploying anything. The budget is the only thing standing between
a misconfiguration and a ~$300 compute bill.

1. Create a Modal workspace **dedicated to Scanner**. Design §10.3 is explicit:
   unrelated apps in the same workspace can consume the same budget.
2. In the Modal dashboard, set the workspace budget to a **deliberately tiny
   staging value** — a few cents. Do not set $30 yet.
3. Keep that tiny budget through steps 3–5, then run the exhaustion drill in
   step 9 to prove the cap actually stops compute.
4. Only after the drill passes, raise it to **$30/month**.

Record the budget page URL; you will need it again in step 9.

---

## 3. Deploy the provider

```bash
cd services/homr-modal
modal setup                 # one-time auth
modal deploy modal_app.py
```

The first build is slow: it pulls the pinned CUDA base, clones HOMR at
`1ddc6fcc26c4baa746eaffbba7f5e01429063465`, installs from HOMR's committed
`poetry.lock`, and bakes the model weights in with `homr --init --gpu force`.

Modal prints the deployed URL. Record it — it becomes `SCANNER_PROVIDER_URL`.

**What the deploy pins** (design §9.5): the CUDA base by manifest-list digest,
HOMR by commit with a `git rev-parse` assertion, and dependencies via the
lockfile at that commit. What it does not yet pin is the model weights — that is
step 5.

---

## 4. Create a proxy token

The web function is declared `@modal.asgi_app(requires_proxy_auth=True)`, so
Modal rejects unauthenticated traffic before the app sees it.

```bash
modal workspace proxy-tokens create
```

> Modal's CLI surface moves; if that subcommand has been renamed, check
> `modal --help` and the proxy-token docs rather than guessing.

Save the token id and secret. They go **only** into the scanner worker's
environment — never the frontend, never the browser, never a committed file.
Use a Scanner-specific token so revoking it cannot affect Transcoda (§12.2).

---

## 5. Verify the provider, then pin the models

Call the provider directly with the proxy headers:

```bash
export MODAL_URL="https://<your-deployment>.modal.run"
export MODAL_KEY="<token id>"
export MODAL_SECRET="<token secret>"

# Liveness — answers immediately, even while models load.
curl -sS -H "Modal-Key: $MODAL_KEY" -H "Modal-Secret: $MODAL_SECRET" \
  "$MODAL_URL/healthz"

# Readiness — 503 until the warm-up inference has actually succeeded.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Modal-Key: $MODAL_KEY" -H "Modal-Secret: $MODAL_SECRET" \
  "$MODAL_URL/readyz"
```

Poll `/readyz` until it returns 200. Then check the body:

- `"ready": true`
- `"executionProvider": "CUDAExecutionProvider"`
- `"availableExecutionProviders"` contains `CUDAExecutionProvider`
- `"degradedReason": ""` — anything else means warm-up ran but did not exercise
  the full pipeline; investigate before benchmarking.

**Never gate anything on `/healthz`.** It is liveness only, by design.

Now capture the model identities:

```bash
curl -sS -H "Modal-Key: $MODAL_KEY" -H "Modal-Secret: $MODAL_SECRET" \
  "$MODAL_URL/v1/capabilities" | python3 -m json.tool
```

Take `segmentationModelSha256`, `encoderModelSha256`, and `decoderModelSha256`,
then redeploy with them pinned so a silently changed weight file fails readiness
instead of quietly altering results:

```bash
export HOMR_EXPECTED_SEGMENTATION_SHA256=<segmentationModelSha256>
export HOMR_EXPECTED_ENCODER_SHA256=<encoderModelSha256>
export HOMR_EXPECTED_DECODER_SHA256=<decoderModelSha256>
modal deploy modal_app.py
```

These are read at deploy time and baked into the image environment, because
Modal re-imports the module inside the container where your shell's variables do
not exist. Confirm `/readyz` still returns 200 after the redeploy.

---

## 6. Wire OurTextScores

On the VPS, edit `/opt/ourtextscores/.env`:

```bash
SCANNER_ENABLED=true
NEXT_PUBLIC_SCANNER_ENABLED=true
SCANNER_BETA_USER_IDS=<your Mongo user id>   # NOT '*'

SCANNER_PROVIDER_KIND=modal
SCANNER_PROVIDER_URL=https://<your-deployment>.modal.run
SCANNER_MODAL_TOKEN_ID=<token id>
SCANNER_MODAL_TOKEN_SECRET=<token secret>

# Fail-closed provenance checks. If any of these disagree with what the
# provider reports, the worker disables the provider rather than continuing.
SCANNER_EXPECTED_HOMR_COMMIT=1ddc6fcc26c4baa746eaffbba7f5e01429063465
SCANNER_EXPECTED_PROVIDER_REVISION=ots-homr-modal-v1
SCANNER_EXPECTED_EXECUTION_PROVIDER=CUDAExecutionProvider

# Set this before any real traffic. Without it the hashed owner segment in
# object keys and logs is obfuscation, not a barrier.
SCANNER_OBJECT_KEY_SALT=<long random string, generate once, never rotate casually>

SCANNER_PROVIDER_BUDGET_EXHAUSTED=false
```

Leave `SCANNER_MULTIPAGE_MERGE_ENABLED=false` for now — turn assembly on only
after you have seen real HOMR output, since it has so far only been exercised
against synthetic fixtures.

**Do not change `SCANNER_PROVIDER_TIMEOUT_MS` in isolation.** It sits in a
ladder that must stay ordered, or an abandoned page keeps billing GPU time after
OTS has already given up on it:

```
HOMR_READY_WAIT_SECONDS (150) + HOMR_HARD_TIMEOUT_SECONDS (400)
    <  SCANNER_PROVIDER_TIMEOUT_MS (600 s)
    <  Modal function timeout (660)
```

A cold request can spend the readiness wait *and then* the full inference
timeout, so it is their **sum** that must stay under the caller's timeout. Change
one, change all of them (the provider-side values live in
`services/homr-modal/modal_app.py`).

---

## 7. Start the worker

The worker is profile-gated and does not run by default:

```bash
cd /opt/ourtextscores
docker compose --profile scanner up -d scanner_worker
docker compose --profile scanner logs -f scanner_worker
```

The API containers keep `SCANNER_WORKER_ENABLED=false`; only this process leases
jobs and holds the Modal credentials.

---

## 8. End-to-end verification

Sign in as an allowlisted user, go to `/scanner`, upload one real score page,
review, and start.

Watch the worker log — every Scanner line is one JSON object prefixed `scanner `:

```bash
docker compose --profile scanner logs scanner_worker | grep -o 'scanner {.*}'
```

You should see `job_created`, `job_claimed`, `job_prepared`, `job_claimed`,
`page_started`, `page_succeeded`, `job_finished`. On `page_succeeded` confirm:

- `executionProvider` is `CUDAExecutionProvider` — if it says CPU, the provenance
  check should already have disabled the provider; investigate before continuing
- `providerMs` is a plausible GPU latency, not a CPU one
- `modelRevision` matches the pinned HOMR commit

Then confirm the redaction guarantee holds in your environment — upload a page
with an identifying filename and check nothing leaked:

```bash
docker compose --profile scanner logs backend scanner_worker \
  | grep -ciE 'your-filename|score-partwise|Modal-Secret'   # expect 0
```

Finally, as an admin:

```bash
curl -sS -H "Authorization: Bearer <admin token>" \
  'https://<host>/api/scanner/jobs/metrics?windowHours=24' | python3 -m json.tool
```

---

## 9. Budget-exhaustion drill

Design §10.3 requires proving the cap works *before* trusting it.

1. With the tiny staging budget from step 2 still in place, run scans until
   Modal reports the budget exhausted.
2. Confirm Modal actually refuses further compute rather than merely warning.
3. Confirm OTS degrades honestly: queued jobs stay durable, and the user is told
   capacity is exhausted rather than seeing a hard failure.
4. Exercise the OTS kill switch independently:

   ```bash
   # In .env, then restart the worker:
   SCANNER_PROVIDER_BUDGET_EXHAUSTED=true
   ```

   The worker stops claiming jobs and the API refuses new ones with
   "Scanner monthly capacity has been reached". Set it back to `false` and
   confirm queued work resumes.
5. Only now raise the workspace budget to $30/month.

---

## 10. Phase 0 benchmark

The §13.4 timings are stored on the job documents, so the §11.4 gate is a Mongo
aggregate rather than a log scrape:

```js
// Per-page provider latency: p50/p95 against the "warm p95 under 60 s" gate.
db.scanner_jobs.aggregate([
  { $match: { createdAt: { $gte: new Date(Date.now() - 24*3600*1000) } } },
  { $unwind: "$pages" },
  { $match: { "pages.status": "succeeded", "pages.durationMs": { $gt: 0 } } },
  { $group: { _id: null,
      samples: { $sum: 1 },
      p50: { $percentile: { input: "$pages.durationMs", p: [0.5], method: "approximate" } },
      p95: { $percentile: { input: "$pages.durationMs", p: [0.95], method: "approximate" } },
      max: { $max: "$pages.durationMs" } } }
])

// Whole-job wall clock against the "10-page job within 10 minutes warm" gate.
db.scanner_jobs.find(
  { status: { $in: ["succeeded", "partial"] } },
  { jobId: 1, pageCount: 1, timings: 1, providerRevision: 1, modelRevision: 1 }
)

// Approximate billable GPU seconds, for the cost-per-1000-pages projection.
db.scanner_jobs.aggregate([
  { $group: { _id: null, providerSeconds: { $sum: { $divide: ["$timings.providerMs", 1000] } } } }
])
```

Separate cold from warm runs yourself — nothing currently records which a page
was. If that split matters for the gate, it needs a `cold` flag threading from
the provider response; the telemetry field already exists but is never set.

Run the §11.1 corpus, not just a few convenient pages, and record results in the
design doc's §11 section.

---

## 11. Rollback

In descending order of bluntness:

| Situation | Action |
|---|---|
| Bad scans, provider healthy | `SCANNER_ENABLED=false` in `.env`, restart backend and worker |
| Cost concern | `SCANNER_PROVIDER_BUDGET_EXHAUSTED=true`, restart worker. Queued jobs stay durable |
| Bad provider deploy | `modal app rollback` (check `modal app --help`), or redeploy the previous commit |
| Suspected credential exposure | Revoke the proxy token in Modal, rotate, update `.env`, restart worker |
| Stop everything | `docker compose --profile scanner stop scanner_worker` — the API stays up, jobs stay queued |

Nothing is destructive: jobs, artifacts, and retention are unaffected by any of
the above.

---

## 12. Known gaps

- **Cold-start latency** — absorbed rather than eliminated; see §0. The first
  page of an idle-period job pays warm-up on top of inference.
- **Modal runs as root**, and Modal builds its own image, so the non-root /
  read-only-rootfs half of §9.5 and the CI SBOM+Trivy scan cover the CPU image
  only. The CUDA base layer and the `gpu` extra are unscanned.
- **Assembly is untested against real HOMR output.** Keep
  `SCANNER_MULTIPAGE_MERGE_ENABLED=false` until you have looked at real results.
- **Alert delivery is unconfigured.** The metrics endpoint exposes what §13.4
  wants to alert on; wiring it to something that pages you is not done.
- **Cold/warm split, lease-reclaim totals, and quota denials** are not counted.
