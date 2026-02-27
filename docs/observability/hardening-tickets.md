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
  - `POST /api/analytics/events` is still auth-optional (`backend/src/analytics/analytics.controller.ts`).
  - Event name/source/property validation is already in place (`backend/src/analytics/analytics.service.ts`).
- Remaining:
  - Add source-level allowlist policy (trusted vs untrusted events).
  - Add per-IP/per-user rate limiting.
  - Add signed ingest or server-only KPI ingestion path.

### OTS-H02 Analytics aggregation scalability
- Status: `todo`
- Why:
  - Dashboard/funnel/retention are currently computed from raw events on request (`backend/src/analytics/analytics.service.ts`).
- Remaining:
  - Add daily materialized rollups + scheduled jobs.
  - Keep raw-query endpoints for debug/audit only.

### OTS-H03 Score editor telemetry depth
- Status: `todo`
- Why:
  - No dedicated OTS editor behavioral event feed yet (edit sessions, apply success/failure, abandon points).
- Remaining:
  - Add editor session lifecycle and AI operation telemetry in `OTS_Web`.
  - Ingest into backend analytics with correlation ids.

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
- Status: `todo`
- Why:
  - Frontend test typing debt remains (separate from app build pass).
- Remaining:
  - Add test tsconfig split and enforce in CI, or fix test type errors directly.

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
