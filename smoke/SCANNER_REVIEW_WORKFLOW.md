Run the guided scanner review browser tests against a running local stack:

```sh
SCANNER_REVIEW_SOURCE_JOB_ID=<completed-scan-id> npm run smoke:scanner:review-workflow
```

The source needs a completed page recognized by OTS-HOMR and another engine,
with retained scan geometry, optional-head proposals, and uncertainty questions.
The API and worker must run the current backend; the frontend must contain the
current guided review UI. Chromium must be installed (`npm run smoke:install`).

The suite creates a separate test owner and scan for every flow. If the source
has already been reviewed, it starts from its saved original base checkpoint.
It reuses immutable source artifacts and creates its own corrections, checkpoints, and
merged scores. It never edits the source job or triggers new recognition.
Preparing optional heads and applying corrections use the configured worker's
symbolic materialization endpoint. The test fixtures deliberately remove legacy
proposal mappings to exercise recovery from retained data.

Coverage:

- Save an original recognition choice without getting stuck in repeated 409s.
- Show persistent conflict reasons; refresh and successfully retry stale conflicts.
- Show processing feedback and resume a pending correction after reloading.
- Save skipped-question progress and resume it after reloading.
- Skip any stage, persist its skipped status, and redo base review afterward.
- Select all additional heads by default while preserving a saved subset.
- Keep the base reading explicitly when optional features need no merge edits.
- Merge additional heads, then use that exact saved score in the engine merge.
- Persist skipped engine conflicts; reopen both merge stages independently.
- Redo base review, retain previous results, and mark downstream work stale.
- Keep checkpoint bodies outside MongoDB and the scan below its BSON size limit.

On completion, cleanup removes only test-owned jobs, users, training records,
and artifacts created under the test job's object-storage prefix. It never
calls the application's scan-deletion route, which would also remove shared
source artifacts. Failed runs retain Playwright traces in `test-results/`.

Optional overrides: `BASE_URL`, `SCANNER_API_CONTAINER` (defaults to
`ourtextscores_backend`). NextAuth's secret is read from the repo environment by
the existing Playwright configuration; the suite generates test session cookies
and sends no sign-in emails.
