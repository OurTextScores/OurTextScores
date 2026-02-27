# Hardening Tickets (Draft)

Last updated: 2026-02-27

## Status key

- `done`: implemented
- `partial`: partly implemented; gaps remain
- `todo`: not implemented yet
- `deferred`: intentionally postponed

## Ticket list

### OTS-H01 Analytics ingest integrity
- Status: `partial`
- Why:
  - `POST /api/analytics/events` remains auth-optional by design.
  - Public ingest now has event-level allowlist and request-rate limiting (`backend/src/analytics/analytics.service.ts`, `backend/src/analytics/analytics.controller.ts`).
  - Event name/source/property validation is enforced server-side (`backend/src/analytics/analytics.service.ts`).
- Remaining:
  - Add signed ingest or server-only KPI ingestion path.
  - Externalize rate-limits (Redis/shared store) for multi-instance deploys.

### OTS-H02 Analytics aggregation scalability
- Status: `partial`
- Why:
  - Daily materialized rollup collection and backfill API now exist for timeseries path:
    - `backend/src/analytics/schemas/analytics-daily-rollup.schema.ts`
    - `backend/src/analytics/analytics.service.ts` (`getTimeseries` uses rollups for day+excludeAdmins)
    - `POST /api/analytics/metrics/rollups/backfill` (`backend/src/analytics/analytics.controller.ts`)
- Remaining:
  - Shift overview/funnel/retention heavy paths to rollups or pre-aggregated helper tables.
  - Add scheduled refresh job (instead of request-time refresh only).
  - Keep raw-query endpoints for debug/audit only.

### OTS-H03 Score editor telemetry depth
- Status: `partial`
- Why:
  - Frontend score editor shell now emits session lifecycle events through backend analytics ingest:
    - `score_editor_session_started`
    - `score_editor_iframe_loaded`
    - `score_editor_session_ended`
  - OTS editor runtime now emits in-editor action telemetry through the same ingest path:
    - `score_editor_runtime_loaded`
    - `score_editor_document_loaded`
    - `score_editor_document_load_failed`
    - `score_editor_ai_request`
    - `score_editor_patch_applied`
    - `score_editor_session_summary`
  - Files:
    - `frontend/app/score-editor/page.tsx`
    - `frontend/app/lib/analytics.ts`
    - `frontend/app/api/analytics/events/route.ts`
    - `frontend/app/admin/analytics/page.tsx`
    - `backend/src/analytics/analytics.controller.ts` (`GET /api/analytics/metrics/editor`)
    - `backend/src/analytics/analytics.service.ts` (`getScoreEditorMetrics`)
    - `OTS_Web/components/ScoreEditor.tsx`
    - `OTS_Web/lib/editor-analytics.ts`
- Remaining:
  - Correlate in-editor telemetry with persisted revision outcomes (work/source/revision ids).
  - Add alert thresholds on AI failure spikes and load-failure spikes.

### OTS-H11 Editor-to-outcome correlation
- Status: `todo`
- Why:
  - Editor metrics are now visible in admin dashboards, but are not yet tied to downstream product outcomes.
- Scope:
  - Attach `work_id`, `source_id`, and `revision_id` to editor telemetry events whenever available.
  - Add dashboard views/queries for:
    - AI usage -> revision saved
    - AI usage -> score downloaded
    - AI usage -> revision rated/commented

### OTS-H12 Editor regression alerting
- Status: `todo`
- Why:
  - We can now compute editor reliability metrics, but we do not alert on regressions.
- Scope:
  - Add threshold alerts for:
    - `score_editor_document_load_failed` spikes
    - `score_editor_ai_request` failure-rate spikes
  - Define lookback windows and alert destinations.

### OTS-H13 Trace continuity smoke verification
- Status: `done`
- Why:
  - Added `scripts/smoke-trace-continuity.cjs` and `npm run smoke:trace` to verify trace/request/session continuity across:
    - `frontend` middleware ingress
    - score-editor API route execution (`scoreops.session.open.summary`)
  - Smoke run asserts:
    - response `x-request-id` and `x-trace-id` match injected values
    - matching structured log events exist in both `frontend` and `score_editor_api` docker service logs.

### OTS-H14 Telemetry contract E2E coverage
- Status: `todo`
- Why:
  - Unit and integration coverage exists, but cross-repo contract behavior is not validated end-to-end.
- Scope:
  - Add E2E checks that verify:
    - OTS_Web emits expected telemetry events for representative flows.
    - Backend accepts/sanitizes each editor event contract.
    - Dashboard endpoint reflects ingested editor data.

### OTS-H04 Session semantics
- Status: `partial`
- Why:
  - Stable client session bootstrap now writes `ots_session_id` (`frontend/app/components/client-session-bootstrap.tsx`).
  - Frontend middleware now injects/propagates `x-client-session-id` and `x-session-id` for `/api/*` traffic (`frontend/middleware.ts`).
  - Proxy forwarding now includes session headers (`frontend/app/api/proxy/_lib/upstream.ts`).
  - Backend analytics request context now falls back to `ots_session_id` cookie when headers are missing (`backend/src/analytics/analytics.service.ts`).
  - Score-editor API trace context now normalizes and forwards `x-client-session-id` / `x-session-id`, and returns them on responses (`OTS_Web/lib/trace-http.ts`).
- Remaining:
  - Propagate this session id into any non-proxy cross-service calls that bypass frontend `/api/*` middleware.

### OTS-H05 Download path performance
- Status: `done`
- Why:
  - Download routes now resolve artifacts through targeted lookup path (`resolveDownloadAsset`) instead of full `getWorkDetail(...)` fan-out.
  - Covered by unit tests in `backend/src/works/works.controller.spec.ts` and `backend/src/works/works.service.spec.ts`.

### OTS-H06 Cross-service tracing/APM
- Status: `partial`
- Why:
  - Backend OTel bootstrap exists (`backend/src/observability/otel.ts`).
  - Frontend middleware + proxy header propagation is implemented.
  - Score-editor runtime now propagates/returns trace + session headers and forwards them to upstream providers.
  - Scoreops routes now emit request-summary logs with request/trace/session correlation IDs.
- Remaining:
  - Collector/Grafana local profile and dashboards.
  - Service-level alerting and SLO wiring.
  - Confirm trace continuity across backend-including paths in all containerized deployments.

### OTS-H15 Ingest signing / Redis rate-limit (de-scoped for now)
- Status: `deferred`
- Why:
  - Product decision: do not prioritize signed ingest and Redis-backed ingest throttles in the current cycle.
- Deferred scope:
  - Signed server-origin analytics ingest (HMAC/server-only ingest).
  - Redis-backed distributed ingest rate limiting.

### OTS-H07 Type/test hygiene
- Status: `done`
- Why:
  - Frontend app and test type-check configs are now split:
    - `frontend/tsconfig.json` excludes test files for strict app checks.
    - `frontend/tsconfig.test.json` validates test files with dedicated settings.
  - Test type-check strictness is now enforced:
    - `frontend/tsconfig.test.json` sets `strict: true` and `noImplicitAny: true`.
  - CI gate now runs both frontend type checks:
    - `.github/workflows/frontend-typecheck.yml`
  - New scripts:
    - `npm run typecheck`
    - `npm run typecheck:test`

### OTS-H08 User model index hygiene
- Status: `done`
- Why:
  - Duplicate email index declaration removed from `backend/src/users/schemas/user.schema.ts`.

### OTS-H09 Works module boundaries
- Status: `partial`
- Why:
  - Download + diff endpoints have been extracted into a dedicated controller:
    - `backend/src/works/works-downloads.controller.ts`
  - Engagement/revision feedback endpoints have been extracted:
    - `backend/src/works/works-engagement.controller.ts`
  - Moderation/admin endpoints have been extracted:
    - `backend/src/works/works-moderation.controller.ts`
    - `backend/src/works/works.module.ts` (separate controller registration)
  - `works.controller.ts` now focuses on work/source CRUD, listing/detail, uploads, and progress stream.
- Remaining:
  - Add dedicated unit coverage for `works-downloads.controller.ts`, `works-engagement.controller.ts`, and `works-moderation.controller.ts`.
  - Optionally split large `WorksService` by domain once controller boundaries stabilize.

### OTS-H10 Admin navigation consistency
- Status: `done`
- Why:
  - Shared admin shell now centralizes auth gate and nav links in `frontend/app/admin/layout.tsx`.
  - Admin pages consume shared layout and no longer duplicate top navigation markup.

## Recommended implementation order (current)

1. `OTS-H11` Editor-to-outcome correlation
2. `OTS-H12` Editor regression alerting
3. `OTS-H14` Telemetry contract E2E coverage
4. `OTS-H02` Analytics aggregation scalability
5. `OTS-H06` Cross-service tracing/APM completion
6. `OTS-H09` Works module boundaries completion
