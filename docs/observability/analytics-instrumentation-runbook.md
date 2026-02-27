# Analytics Instrumentation Runbook (V1)

## Implemented (backend)

- `POST /api/analytics/events`
  - accepts one event (`{ eventName, ... }`) or batch (`{ events: [...] }`)
  - validates event names against the metrics spec contract
  - treats client payloads as untrusted by default:
    - server-owned fields (`sourceApp`, `requestId`, `traceId`, `route`) are derived from request context
    - `eventTime` is bounded for untrusted ingest (recent history only; no far-future timestamps)
  - normalizes actor + request context fields
  - applies event-specific property canonicalization (for example `score_downloaded.file_format`)
  - protected by dedicated ingest rate limit (`analytics-ingest`)
- `GET /api/analytics/metrics/overview`
  - admin-only summary endpoint for dashboard backends
  - returns WAE/WACU/WEU and activity counts for a date range
- `GET /api/analytics/metrics/timeseries`
  - admin-only chart data endpoint
  - bucketed metrics (`day|week`) with timezone support
  - computed via MongoDB aggregation pipeline (`$dateTrunc` + grouped uniques), not full event hydration in app memory
- `GET /api/analytics/metrics/funnel`
  - admin-only conversion funnel endpoint
  - signup -> first load -> first revision saved -> returned next week
- `GET /api/analytics/metrics/retention`
  - admin-only cohort endpoint
  - activation cohorts with `W1/W4/W8` retention
- `GET /api/analytics/metrics/catalog`
  - admin-only catalog size endpoint
  - total and range-added counts for works/sources/revisions

## Implemented (frontend)

- Admin dashboard page: `frontend/app/admin/analytics/page.tsx`
  - route: `/admin/analytics`
  - consumes all five metrics endpoints and renders:
    - KPI overview cards
    - daily timeseries bars
    - funnel step conversions
    - retention cohorts table
    - catalog totals and range additions

## Auto-emitted business events

Events emitted server-side from existing API flows:

- `score_viewed`
  - on `GET /api/works/:workId`
- `first_score_loaded`
  - first successful score view per authenticated user
- `score_downloaded`
  - on all source download routes (mxl/xml/pdf/mscz/krn/reference pdf/thumbnail/manifest)
  - emitted best-effort and non-blocking so file delivery latency is not coupled to analytics writes
- `upload_success`
  - on source upload and revision upload endpoints
- `editor_revision_saved`
  - on source upload and revision upload endpoints (`save_mode=manual`)
- `revision_rated`
  - on revision rating endpoint
- `revision_commented`
  - on comment creation endpoint
- `catalog_search_performed`
  - on works search endpoint

## Score editor runtime events

Events emitted directly from `OTS_Web` (iframe runtime), forwarded through `frontend/app/api/analytics/events/route.ts`:

- `score_editor_runtime_loaded`
- `score_editor_document_loaded`
- `score_editor_document_load_failed`
- `score_editor_ai_request`
- `score_editor_patch_applied`
- `score_editor_session_summary`

Notes:

- Runtime events include `editor_session_id` for per-editor correlation.
- When available, runtime events include `api_request_id` / `api_trace_id` copied from score-editor API response headers.

## Data model

Mongo collection: `analytics_events`

Primary fields:

- `eventName`, `eventTime`, `sourceApp`
- `userId`, `userRole` (`anonymous|user|admin`)
- `sessionId`, `requestId`, `traceId`, `route`
- `properties` (bounded JSON object)
- `includeInBusinessMetrics` (false for admin events)

Index notes:

- time and event indexes for dashboard queries
- unique partial index on `(eventName, userId)` for `first_score_loaded`

## Local test commands

From `backend/`:

```bash
npm test -- --runInBand \
  src/analytics/analytics.service.spec.ts \
  src/analytics/analytics.controller.spec.ts \
  src/search/search.controller.spec.ts \
  src/works/works.controller.spec.ts

npm run build
```

## Manual smoke checks

Ingest one event:

```bash
curl -sS -X POST http://localhost:4000/api/analytics/events \
  -H 'Content-Type: application/json' \
  -d '{"eventName":"score_viewed","properties":{"work_id":"123"}}' | jq .
```

Fetch overview (admin auth required):

```bash
curl -sS "http://localhost:4000/api/analytics/metrics/overview?from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq .

curl -sS "http://localhost:4000/api/analytics/metrics/timeseries?bucket=day&timezone=America/New_York" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq '.points[0]'

curl -sS "http://localhost:4000/api/analytics/metrics/funnel" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq '.steps'

curl -sS "http://localhost:4000/api/analytics/metrics/retention?timezone=America/New_York" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq '.cohorts[0]'

curl -sS "http://localhost:4000/api/analytics/metrics/catalog" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq .
```

## Current limitations

- `editor_revision_saved` is currently emitted from upload endpoints only.
- No dedicated frontend session-id generator is enforced yet; anonymous events may have null `sessionId`.
- No UI dashboards are wired yet; these admin APIs are the backend contract for dashboards.

## Tracing / APM integration (backend)

- OTel bootstrap is now available in backend runtime:
  - set `OTEL_ENABLED=true` to enable auto-instrumentation and OTLP trace export
  - optional diagnostics: `OTEL_DIAGNOSTICS=true`
  - optional endpoint overrides:
    - `OTEL_EXPORTER_OTLP_ENDPOINT` (collector base URL, e.g. `http://otel-collector:4318`)
    - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (full traces endpoint, takes precedence)
- Backend now emits `x-trace-id` response header when trace context is present.

## Cross-service trace propagation (frontend/runtime)

- Frontend middleware (`frontend/middleware.ts`) stamps/propagates:
  - `x-request-id`
  - `traceparent`
  - `x-trace-id`
  for all `/api/*` requests.
- Frontend proxy routes (`frontend/app/api/proxy/**/route.ts`) forward trace headers to backend upstream fetches.
- Score editor rewritten API traffic (`/api/score-editor/*`) now carries the same headers through Next rewrite proxying, enabling frontend -> score_editor_api correlation.
- Score editor API runtime (`OTS_Web`) now propagates and returns trace headers on `music/*` and `llm/*` routes, and forwards the same headers to upstream provider calls (OpenAI/Anthropic/Gemini/Hugging Face/Space).
