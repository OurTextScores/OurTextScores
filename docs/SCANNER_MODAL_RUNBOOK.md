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
- The Modal CLI. It is a standalone tool, and most distributions now ship a
  PEP 668 "externally managed" Python that refuses `pip install` into the system
  interpreter, so install it in its own environment:

  ```bash
  pipx install 'modal>=1.2,<2'     # or: uv tool install 'modal>=1.2,<2'
  modal --version                  # verified against 1.5.3
  ```

  `services/homr-modal/requirements.txt` carries the same constraint if you
  prefer a venv (`python3 -m venv .venv && .venv/bin/pip install -r ...`).
  Note `python3`, not `python` — many systems no longer provide the latter.
- Shell access to the OTS VPS.

> **VPS reality check.** `/opt/ourtextscores` is not a git checkout, the Compose
> files there are unmanaged, and `deploy-backend.yml` only deploys the backend
> image. Every Compose and `.env` change in steps 7–8 is a **manual** edit on the
> VPS and will not arrive via CI.

---

## 2. Workspace and budget

Do this before deploying anything. The budget is the only thing standing between
a misconfiguration and a ~$300 compute bill.

1. Create a Modal workspace **dedicated to Scanner**. Design §10.3 is explicit:
   unrelated apps in the same workspace can consume the same budget. The
   *workspace* is the budget boundary; the environment inside it can stay `main`.
2. In the Modal dashboard, set the workspace budget to a **deliberately tiny
   staging value** — a few cents. Do not set $30 yet.
3. Keep that tiny budget through the local rehearsal in step 6, then run the
   exhaustion drill in step 10 to prove the cap actually stops compute.
4. Only after the drill passes, raise it to **$30/month**.

Record the budget page URL; you will need it again in step 10.

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
HOMR by commit with a `git rev-parse` assertion, and every dependency by hash —
resolved from the lockfile at that commit and installed under
`pip --require-hashes`, so a tampered or substituted artifact fails the build.
What it does not yet pin is the model weights; that is step 5.

---

## 4. Create a proxy token

The web function is declared `@modal.asgi_app(requires_proxy_auth=True)`, so
Modal rejects unauthenticated traffic before the app sees it.

```bash
modal workspace proxy-tokens create
modal workspace proxy-tokens list      # confirm it exists
```

`modal workspace proxy-tokens list` shows `Scoped: False` for a token that is
not restricted to an environment — that is the default, and such a token already
authenticates across the whole workspace, so **no further step is needed.**

Only if you deliberately scope a token do you need to authorise it, and the
argument is an *environment* name, not the workspace name. A new workspace has
one environment called `main`:

```bash
modal environment list                                        # usually just: main
modal workspace proxy-tokens allow <token-id> --environment main
```

> **Workspace is not environment.** The workspace is the billing and budget
> boundary — the thing design §10.3 wants dedicated to Scanner. An environment is
> a namespace inside it. Naming your workspace `scanner` does not create an
> environment called `scanner`, and passing one that does not exist fails with
> `Environment 'scanner' not found`.

Save the token id and secret. They go **only** into the scanner worker's
environment — never the frontend, never the browser, never a committed file.
Use a Scanner-specific token so revoking it cannot affect Transcoda (§12.2).

---

## 5. Verify the provider, then pin the models

Put the endpoint and token in your **local** `.env` first:

```bash
SCANNER_PROVIDER_URL=https://<your-deployment>.modal.run
SCANNER_MODAL_TOKEN_ID=<token id>
SCANNER_MODAL_TOKEN_SECRET=<token secret>
```

Then run the pre-flight check, which sends exactly the headers the scanner
worker will send — so a pass here means the worker will authenticate too:

```bash
npm run scanner:modal:check
```

It verifies proxy auth, waits for readiness, compares the provider's reported
HOMR commit / service revision / execution provider against what OTS will
require (these are fail-closed at runtime, so a mismatch would disable the
provider mid-scan), checks the AGPL disclosure fields, and prints the model
hashes as ready-to-paste export lines. Exit code is non-zero if anything failed.

The hashes for the pinned HOMR commit are already committed as
`DEFAULT_MODEL_SHA256` in `services/homr-modal/modal_app.py`, so a normal deploy
is pinned with nothing further to do. The check should print exactly those
values; if it does not, the weights have moved and you should find out why
before going further.

**Do not put these in `.env`.** They are read at *deploy time* by
`modal_app.py`, and baked into the image environment because Modal re-imports
the module inside the container where your shell's variables do not exist. OTS
never reads them, so `.env` would have no effect. They belong in the file beside
`HOMR_COMMIT` and `CUDA_BASE_DIGEST` — they are pins, not secrets.

Only when `HOMR_COMMIT` moves do you re-capture them: run the check against the
new build, then either update `DEFAULT_MODEL_SHA256` (preferred — committed and
reviewable) or override for one deploy:

```bash
export HOMR_EXPECTED_SEGMENTATION_SHA256=<printed value>
export HOMR_EXPECTED_ENCODER_SHA256=<printed value>
export HOMR_EXPECTED_DECODER_SHA256=<printed value>
cd services/homr-modal && modal deploy modal_app.py
```

Prefer the committed form: a forgotten `export` silently produces an *unpinned*
image, because an empty value is dropped and nothing fails.

> The GPU image loads **fp16** weights, so these hashes differ from the CPU
> image's. That also means CPU and GPU benchmark results are not directly
> comparable — different models, not just different hardware.

<details>
<summary>Manual equivalent, if you would rather curl it</summary>

`modal curl` signs requests with your local Modal credentials, so you do not
have to assemble proxy headers by hand — handy for poking at the endpoint,
though it does not exercise the proxy token the worker will actually use:

```bash
export MODAL_URL="https://<your-deployment>.modal.run"
modal curl "$MODAL_URL/readyz"
modal curl "$MODAL_URL/v1/capabilities"
```

With the proxy token, exactly as the worker sends it:

```bash
AUTH=(-H "Modal-Key: <token id>" -H "Modal-Secret: <token secret>")
curl -sS "${AUTH[@]}" "$MODAL_URL/healthz"    # liveness, answers immediately
curl -sS "${AUTH[@]}" "$MODAL_URL/readyz"     # 503 until warm-up succeeded
curl -sS "${AUTH[@]}" "$MODAL_URL/v1/capabilities" | python3 -m json.tool
```

`/readyz` should report `"ready": true`, `"executionProvider":
"CUDAExecutionProvider"`, and an empty `"degradedReason"` — anything else means
warm-up ran without exercising the full pipeline. **Never gate anything on
`/healthz`;** it is liveness only, by design.

</details>

---

## 6. Rehearse from local, before touching the VPS

Point a local OTS stack at the real Modal deployment. Everything except where
OTS runs is identical to production — same provider, same fail-closed provenance
checks, same timeout ladder — so this catches configuration and provenance
problems while the blast radius is your laptop.

```bash
npm run scanner:modal:up      # builds and starts, scanner profile, no CPU provider
npm run scanner:modal:logs    # follow the worker
```

The override reads `SCANNER_PROVIDER_URL`, `SCANNER_MODAL_TOKEN_ID`, and
`SCANNER_MODAL_TOKEN_SECRET` from your `.env` and refuses to start if any is
missing, rather than bringing up a stack that cannot scan. It enables Scanner
for all local users (`SCANNER_BETA_USER_IDS: "*"`) — that is a local-only
convenience; the VPS uses a real allowlist.

Sign in locally, upload a real score page at http://localhost:3000/scanner, and
work through §9's verification against this stack. When you are done:

```bash
npm run scanner:modal:down
```

**This bills real GPU time.** Do it while the small staging budget from step 2 is
still in place — the rehearsal and the budget drill in §9 are the same exercise,
and finding out here that the cap works is exactly the point.

Only move on once a page has round-tripped end to end with
`executionProvider: CUDAExecutionProvider` in the logs.

---

## 7. Wire the VPS

Only once step 6 has round-tripped a page. These are the same values you proved
locally, plus the two that differ in production: a real beta allowlist instead of
`*`, and an object-key salt.

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

## 8. Start the worker

The worker is profile-gated and does not run by default:

```bash
cd /opt/ourtextscores
docker compose --profile scanner up -d scanner_worker
docker compose --profile scanner logs -f scanner_worker
```

The API containers keep `SCANNER_WORKER_ENABLED=false`; only this process leases
jobs and holds the Modal credentials.

---

## 9. End-to-end verification

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

## 10. Budget-exhaustion drill

Design §10.3 requires proving the cap works *before* trusting it. The drill has
two halves: what OTS does when capacity is gone, and whether Modal actually
stops compute.

### 10a. The OTS half — verified 2026-08-08

Run with `SCANNER_PROVIDER_BUDGET_EXHAUSTED`, which costs nothing and needs no
Modal spend. Sequence, and what each step proved:

| Step | Result |
|---|---|
| Job started with the worker stopped | sits `queued` |
| Switch **on**, worker running for 20 s | still `queued` — held, not failed |
| `POST /scanner/jobs` while exhausted | `503 Scanner monthly capacity has been reached` |
| Switch **off**, worker restarted | resumed to `succeeded` with **one** provider attempt |

The important property is the last one: held work resumes without
re-submission and without burning an extra provider call, and `queueWaitMs`
(28,593 ms in the run above) accounts for the hold. Re-run this after any change
to the worker's claim path.

### 10b. The Modal half — verified 2026-08-08

`modal` has no budget command (`modal workspace settings` only exposes
`default-environment` and `image-builder-version`), so the cap is set in the
dashboard.

**Do not try to burn a large budget down.** At roughly 81 s per cold burst
(≈20 s start + ~1 s scan + 60 s `scaledown_window` idle ≈ $0.018), clearing
$0.77 needs ~43 bursts and about an hour of wall clock — spent proving a
setting, with budget the §11.1 corpus needs. Lower the cap to just above current
spend instead and it costs a handful of scans.

**Result of the drill.** With the cap at $0.25 and metered spend at $0.18,
repeated cold starts reached the cap and Modal stopped serving:

```
iteration 6 | metered=$0.25   /readyz -> HTTP 503   (still warming, still serving)
iteration 7 | metered=$0.27   /readyz -> HTTP 404
                              modal-http: workspace ac-… is disabled
```

Three things this establishes, all load-bearing for the pilot:

1. **The cap is a hard stop, not a warning.** §10.3's core assumption holds.
2. **It is enforced on *metered* cost, not billed cost.** Billed cost was $0.00
   throughout — the included credit covered everything — yet the cap still fired.
   So a $30 budget fires at $30 of *gross* usage, which is what §10.3 intends.
   Had it tracked billed cost, a $30 budget behind $30 of credit would never
   have triggered at all.
3. **Enforcement overshoots slightly** — $0.27 against a $0.25 cap, about $0.02,
   presumably billing lag. Budget for a small overrun; it is not to the cent.

**The failure mode is a plain-text `404`, not a structured error**, and it
disables the *whole workspace*, not just the GPU function. OTS now recognises
that signature and reports `provider_budget_exhausted` ("Scanner monthly
capacity has been reached") rather than "rejected the request (404)". That
mapping matters twice over: a bare 404 is not in the retryable set, so affected
pages could not have been retried by hand even after the budget was raised,
which is what §13.1 asks for. `npm run scanner:modal:check` recognises it too.

**To restore service:** raise the workspace budget in the dashboard. Nothing in
OTS needs restarting; queued jobs are durable and resume.

Then set the pilot budget to **$30/month** and clear
`SCANNER_PROVIDER_BUDGET_EXHAUSTED` if you set it.

## 11. Phase 0 benchmark

The §13.4 timings are stored on the job documents, so the §11.4 gate is a Mongo
aggregate rather than a log scrape:

**Use `inferenceMs`, not `durationMs`, for recognition time.** Each page records
both: `durationMs` is the caller's wall clock and includes any cold-start wait,
while `inferenceMs` is recognition measured inside the provider. On a cold
container these differ by more than an order of magnitude — 21,117 ms against
928 ms in a measured run — so using wall clock as "recognition time" would
report the GPU as ~20× slower than it is. Design §11.3 requires the separation.

```js
// Recognition latency: p50/p95 against the "warm p95 under 60 s" gate.
db.scanner_jobs.aggregate([
  { $match: { createdAt: { $gte: new Date(Date.now() - 24*3600*1000) } } },
  { $unwind: "$pages" },
  { $match: { "pages.status": "succeeded", "pages.inferenceMs": { $gt: 0 } } },
  { $group: { _id: null,
      samples: { $sum: 1 },
      p50: { $percentile: { input: "$pages.inferenceMs", p: [0.5], method: "approximate" } },
      p95: { $percentile: { input: "$pages.inferenceMs", p: [0.95], method: "approximate" } },
      max: { $max: "$pages.inferenceMs" } } }
])

// Cold-start cost: how much wall clock is not recognition. A large gap means
// the page waited on a cold container, so treat it as a cold sample.
db.scanner_jobs.aggregate([
  { $unwind: "$pages" },
  { $match: { "pages.status": "succeeded", "pages.inferenceMs": { $gt: 0 } } },
  { $project: { jobId: 1, _id: 0,
      inferenceMs: "$pages.inferenceMs",
      waitMs: { $subtract: ["$pages.durationMs", "$pages.inferenceMs"] } } },
  { $sort: { waitMs: -1 } }
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

The second query gives you the cold/warm split in practice: a page whose
`waitMs` is seconds rather than milliseconds waited on a cold container. There
is no explicit `cold` boolean — the telemetry field exists but is never set —
so use that gap as the discriminator.

Run the §11.1 corpus, not just a few convenient pages, and record results in the
design doc's §11 section.

---

## 12. Rollback

In descending order of bluntness:

| Situation | Action |
|---|---|
| Bad scans, provider healthy | `SCANNER_ENABLED=false` in `.env`, restart backend and worker |
| Cost concern | `SCANNER_PROVIDER_BUDGET_EXHAUSTED=true`, restart worker. Queued jobs stay durable |
| Bad provider deploy | `modal app history` then `modal app rollback`, or redeploy the previous commit |
| Suspected credential exposure | Revoke the proxy token in Modal, rotate, update `.env`, restart worker |
| Stop everything | `docker compose --profile scanner stop scanner_worker` — the API stays up, jobs stay queued |

Nothing is destructive: jobs, artifacts, and retention are unaffected by any of
the above.

---

## 13. Known gaps

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
