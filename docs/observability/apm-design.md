# OurTextScores APM Design

## Goal

Add production-grade observability for `OurTextScores` (backend + frontend + score editor API integration) with:

- request metrics (latency, throughput, errors)
- distributed traces (cross-service request flow)
- structured logs correlated by trace/request id

## Scope

- `OurTextScores/backend` (NestJS API) - primary APM target
- `OurTextScores/frontend` (Next.js) - server-side request traces and key client web-vitals
- `OTS_Web` score editor API (`/api/music/*`) - tool routing and operation timing

## Non-goals (phase 1)

- full business analytics dashboards
- per-user behavioral analytics
- long-term SIEM/security telemetry

## Recommended Architecture

Use OpenTelemetry (OTel) end-to-end, export with OTLP.

Components:

1. App instrumentation (Node SDK in backend/frontends)
2. OTel Collector (receives OTLP from apps)
3. Storage/visualization:
   - traces: Tempo (or managed Grafana Cloud / Datadog backend)
   - metrics: Prometheus
   - logs: Loki
   - dashboards: Grafana

Why this stack:

- open standard (vendor-neutral)
- easy to start local, easy to migrate to managed backends
- works for Node/Nest/Next with existing instrumentations

## Telemetry Model

### Resource attributes

Set on every service:

- `service.name` (`ourtextscores-backend`, `ourtextscores-frontend`, `ots-web-score-editor-api`)
- `service.version` (git SHA / release tag)
- `deployment.environment` (`local`, `staging`, `prod`)

### Traces

Spans to prioritize:

- Backend:
  - incoming HTTP request spans
  - MongoDB query spans
  - MinIO I/O spans
  - outbound HTTP spans (e.g. score editor API / HF calls if proxied)
- Frontend (server-side Next handlers):
  - API route spans
  - backend fetch spans
- OTS_Web:
  - `/api/music/agent` route
  - scoreops planning/apply/retry/fallback spans

### Metrics

Minimum SLO set:

- request rate by route/service
- p50/p95/p99 latency by route
- error rate (4xx/5xx split)
- dependency latency/error:
  - Mongo
  - MinIO
  - score editor API

### Logs

Use JSON logs with:

- `timestamp`, `level`, `service.name`
- `trace_id`, `span_id` (when available)
- `request_id` / `traceId`
- `event` and structured fields (no raw score XML/prompt content)

## Correlation Strategy

1. Generate/accept request id at edge (`x-request-id`).
2. Propagate W3C trace context (`traceparent`, `tracestate`) between services.
3. Include trace/request id in:
   - response headers (`x-trace-id`)
   - app logs
   - error payloads only where useful for support/debug.

## Security and Data Hygiene

Do not emit to telemetry:

- raw MusicXML/ABC/score payloads
- full LLM prompts/responses containing user content
- auth tokens / secrets

Allow only bounded metadata in spans/logs:

- prompt length
- op counts
- selected tool/fallback reason
- status codes and timing

## Rollout Plan

### Phase 0: Baseline (1-2 days)

- Add request-id middleware/interceptor in backend.
- Keep always-on summary logs for critical routes:
  - backend API
  - `OTS_Web /api/music/agent`
- Keep opt-in verbose trace logs (env flag) for development incidents.

### Phase 1: Backend APM (2-4 days)

- Add `@opentelemetry/sdk-node` to backend.
- Enable auto-instrumentations:
  - `http`, `express` (or Nest HTTP layer), `mongodb`
- Export OTLP -> collector.
- Build initial Grafana dashboard for:
  - latency percentiles
  - error rates
  - dependency timings

Current status (2026-02):

- Implemented in backend:
  - optional OTel bootstrap (`OTEL_ENABLED=true`)
  - auto-instrumentation via Node SDK
  - OTLP trace export support (`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
  - response header correlation (`x-trace-id`) when trace context exists
- Pending:
  - collector/grafana local profile
  - frontend + score editor API trace propagation completion
  - alert definitions

### Phase 2: Frontend + OTS_Web server traces (2-4 days)

- Add OTel Node instrumentation to Next server runtimes.
- Instrument key API routes (`/api/music/*`) with manual spans around planner/executor phases.
- Propagate `traceparent` on internal fetch calls.

### Phase 3: Alerting and SLOs (2-3 days)

- Define alerts:
  - p95 latency breach
  - 5xx error rate threshold
  - downstream dependency failure spikes
- Add service-level dashboards for on-call triage.

## Environment Variables (proposed)

Common:

- `OTEL_SERVICE_NAME`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` recommended)
- `OTEL_TRACES_SAMPLER` (`parentbased_traceidratio`)
- `OTEL_TRACES_SAMPLER_ARG` (`0.05`-`0.2` baseline)

Custom:

- `MUSIC_AGENT_TRACE=1` (detailed route decision logs; keep off by default)
- `OBS_LOG_SUMMARY=1` (always-on summary logs)

## Local Dev Topology (recommended)

Add an observability compose profile:

- `otel-collector`
- `tempo`
- `prometheus`
- `loki`
- `grafana`

App services send OTLP to collector at `http://otel-collector:4318`.

## Success Criteria

- Can trace a single user request end-to-end across frontend -> backend -> score editor API.
- Can answer in <5 minutes:
  - which route/tool path failed
  - where time was spent
  - whether failure is app logic vs dependency.
- Error/latency regressions are alertable without manual log hunting.
