# Hardening Tickets (Draft)

Last updated: 2026-02-27

## Status key

- `done`: implemented
- `partial`: partly implemented; gaps remain
- `todo`: not implemented yet

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
    - `OTS_Web/components/ScoreEditor.tsx`
    - `OTS_Web/lib/editor-analytics.ts`
- Remaining:
  - Correlate in-editor telemetry with persisted revision outcomes in analytics dashboards.
  - Add alert thresholds on AI failure spikes and load-failure spikes.

### OTS-H04 Session semantics
- Status: `partial`
- Why:
  - Stable client session bootstrap now writes `ots_session_id` (`frontend/app/components/client-session-bootstrap.tsx`).
  - Frontend middleware now injects/propagates `x-client-session-id` and `x-session-id` for `/api/*` traffic (`frontend/middleware.ts`).
  - Proxy forwarding now includes session headers (`frontend/app/api/proxy/_lib/upstream.ts`).
  - Backend analytics request context now falls back to `ots_session_id` cookie when headers are missing (`backend/src/analytics/analytics.service.ts`).
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
  - Score-editor runtime now propagates/returns trace headers and forwards to upstream providers.
- Remaining:
  - Collector/Grafana local profile and dashboards.
  - Service-level alerting and SLO wiring.
  - Confirm trace continuity across all containerized deployments.

### OTS-H07 Type/test hygiene
- Status: `partial`
- Why:
  - Frontend app and test type-check configs are now split:
    - `frontend/tsconfig.json` excludes test files for strict app checks.
    - `frontend/tsconfig.test.json` validates test files with dedicated settings.
  - New scripts:
    - `npm run typecheck`
    - `npm run typecheck:test`
- Remaining:
  - Tighten `tsconfig.test.json` strictness and gradually fix test typing debt.
  - Add CI gates for both scripts.

### OTS-H08 User model index hygiene
- Status: `done`
- Why:
  - Duplicate email index declaration removed from `backend/src/users/schemas/user.schema.ts`.

### OTS-H09 Works module boundaries
- Status: `todo`
- Why:
  - `works.controller.ts` still spans uploads/moderation/downloads/analytics hooks.
- Remaining:
  - Split into focused modules/services (downloads, moderation, revisions, analytics emitters).

### OTS-H10 Admin navigation consistency
- Status: `done`
- Why:
  - Shared admin shell now centralizes auth gate and nav links in `frontend/app/admin/layout.tsx`.
  - Admin pages consume shared layout and no longer duplicate top navigation markup.

## Recommended implementation order

1. `OTS-H08` (quick hygiene)
2. `OTS-H05` (user-facing latency/DB load)
3. `OTS-H01` (data trust hardening)
4. `OTS-H04` (improves metric quality)
5. `OTS-H02` (scale path)
6. `OTS-H10` (UI consistency)
7. `OTS-H07` (CI quality gates)
8. `OTS-H03` + `OTS-H06` completion (advanced observability)
9. `OTS-H09` (larger refactor)
