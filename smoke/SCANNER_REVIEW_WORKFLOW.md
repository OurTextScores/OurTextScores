Run the scanner engine-merge browser tests against a running local stack:

```sh
SCANNER_REVIEW_SOURCE_JOB_ID=<completed-scan-id> npm run smoke:scanner:review-workflow
```

The source needs a completed page recognized by OTS-HOMR and another engine,
with retained scan geometry and at least one comparison conflict. The API,
worker, and frontend must run the current code. Install Chromium with
`npm run smoke:install` if needed.

Each flow creates an isolated owner and scan. For an already-reviewed source,
the fixture starts from its immutable original base checkpoint. Tests share
immutable source artifacts and create only their own merge/checkpoint artifacts.
They never edit the source scan or invoke recognition or head materialization.

Coverage:

- Open directly in the engine merge without the former base/head review stages.
- Save a conflict decision; resume it after reload and on the comparison page.
- Open an older additional-heads review automatically and carry its saved result
  into the engine comparison, verified by the exact score checksum.
- Refresh a stale comparison response internally, without navigating the page.
- Keep the exact scan crop valid after a real merge save changes the job version.
- Switch Across → Stacked without changing the drawable width or alternating pane sizes,
  while keeping wheel scrolling on the host page.
- Draw visible merged music on every conflict, including later engraved pages.
  Scan `d9223ba7-2029-467c-8b65-6554838e5b5e` exercises this multipage regression.
- Retain compact checkpoint references and stay below MongoDB's BSON size limit.

Cleanup removes only test-owned jobs, users, training records, and artifacts
under the test job's object-storage prefix. It never calls the application's
scan-deletion route, which would remove shared source artifacts. Failed runs
retain Playwright traces in `test-results/`.

Optional overrides: `BASE_URL`, `SCANNER_API_CONTAINER` (default
`ourtextscores_backend`). The existing Playwright configuration loads the repo
environment. Tests mint their own session cookies and send no sign-in emails.

To exercise the scrollbar regression with classic scrollbars on Linux:

```sh
SCANNER_REVIEW_WORKFLOW=1 SCANNER_CLASSIC_SCROLLBARS=1 \
SCANNER_REVIEW_SOURCE_JOB_ID=<completed-scan-id> \
xvfb-run -a npx playwright test -c smoke/playwright.config.cjs \
  --project=chromium --headed scanner-review-workflow.spec.cjs \
  -g 'keeps pane widths stable'
```

This verifies a nonzero scrollbar gutter as well as stable widths. Headless
Chromium normally uses overlay scrollbars and cannot expose the original 15 px
width change.
