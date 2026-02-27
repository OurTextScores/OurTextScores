# OurTextScores Metrics Semantics (V1)

## Scope

This document defines the business metric semantics agreed in discovery.

- Product model: no monetization metrics (yet)
- Primary goals: growth, engagement, retention, catalog growth
- User population: `user` and `admin`, but business KPIs exclude `admin`
- Reporting timezone: `America/New_York` (EST/EDT)

## North Star and Companion Metrics

### Primary North Star

- `Weekly Active Editors (WAE)`
- Definition: count of unique non-admin users with at least one editor creation/edit action in a week.
- Qualifying events:
  - `upload_success`
  - `editor_revision_saved`

### Companion Engagement Metrics

- `Weekly Active Catalogue Users (WACU)`
  - unique non-admin users with at least one catalog interaction in a week.
  - includes passive views.
  - qualifying events:
    - `catalog_search_performed`
    - `score_viewed`
    - `revision_commented`
    - `revision_rated`
    - `score_downloaded`
- `Weekly Engaged Users (WEU)`
  - union of WAE and WACU users in a week.

## Activation and Funnel

### Activation

- Activation event: first `editor_revision_saved`
- Activation window: within 7 days from `signup_completed`
- Activation rate:
  - numerator: users with activation in window
  - denominator: users with `signup_completed`

### Core Funnel

1. `signup_completed`
2. `first_score_loaded` (existing scores count)
3. `first_revision_saved`
4. `returned_next_week` (any engagement, not editor-only)

Step 4 qualifies on any of:

- `upload_success`
- `editor_revision_saved`
- `catalog_search_performed`
- `score_viewed`
- `revision_commented`
- `revision_rated`
- `score_downloaded`

## Retention

- Cohort basis: activation cohort
- Windows: `W1`, `W4`, `W8`
- Retained user: activated user with any qualifying engagement event in that target week.

## KPI Definitions

### Growth KPIs

- `new_signups` (weekly)
- `new_activated_users` (weekly)
- `WAE`, `WACU`, `WEU` (weekly)
- `catalog_size_total` (current total visible works/sources/revisions; choose one canonical level per dashboard)
- `catalog_net_new_weekly` (new catalog entities per week)

### Activity KPIs

- `uploads_success`
- `revisions_saved`
- `editor_sessions`
- `comments_created`
- `ratings_created`
- `downloads_total`
- `downloads_by_format` (csv/json split by `file_format`)

### Reliability Guardrails

- API:
  - request volume
  - `5xx` rate
  - p95/p99 latency by route group
- Editor flow:
  - upload success rate
  - revision save success rate
  - scoreops failure rate
- Async jobs:
  - derivative generation failure rate
  - queue age / processing lag (if queue telemetry exists)

## Event Contract (V1)

All events MUST include:

- `event_name`
- `event_time` (UTC)
- `user_id` (or null for anonymous where applicable)
- `user_role` (`user` | `admin` | `anonymous`)
- `session_id`
- `request_id` / `trace_id` if available
- `source_app` (`frontend` | `backend` | `score_editor_api`)

### Required Business Events

- `signup_completed`
  - props: `signup_method`
- `first_score_loaded`
  - props: `entry_type` (`existing` | `uploaded` | `new`)
- `upload_success`
  - props: `work_id`, `source_id`, `revision_id`, `file_ext`, `file_size_bytes`
- `editor_revision_saved`
  - props: `work_id`, `source_id`, `revision_id`, `save_mode` (`manual` | `autosave` | `ai_patch_apply`)
- `catalog_search_performed`
  - props: `query_length`, `result_count`, `search_scope`
- `score_viewed`
  - props: `work_id`, `source_id`, `revision_id`, `view_surface`
- `revision_commented`
  - props: `work_id`, `source_id`, `revision_id`, `is_reply`
- `revision_rated`
  - props: `work_id`, `source_id`, `revision_id`, `rating_value`
- `score_downloaded`
  - props: `work_id`, `source_id`, `revision_id`, `file_format`, `download_surface`

### Ingest trust model (V1)

- Public/client ingest is treated as untrusted.
- Server-owned context fields are derived from the request path/headers, not accepted from payload:
  - `source_app`
  - `request_id`
  - `trace_id`
  - `route`
- Untrusted events with stale/far-future `event_time` are rejected.
- Event properties are canonicalized per event schema (unknown/malformed values are dropped or normalized).

### Download `file_format` enum (initial)

- `pdf`
- `musicxml`
- `mxl`
- `mscz`
- `mscx`
- `midi`
- `png`
- `svg`
- `other`

## Segment Dimensions

Default filters for dashboards:

- time (week/day in EST)
- user_role (admin excluded by default)
- country (if available)
- device type (`desktop` | `mobile` | `tablet`)
- acquisition source (if available)
- score format / download format

## Metric Computation Rules

- All KPI queries default to `user_role != 'admin'`.
- Weekly buckets use EST week boundaries.
- De-duplication:
  - uniques based on `(user_id, week)`
  - activation uses first observed `editor_revision_saved` per user.
- Late-arriving events:
  - allow 24h backfill for daily dashboards
  - allow 72h backfill for weekly aggregates.

## Dashboard Set (V1)

1. `Executive Overview`
   - WAE, WACU, WEU, new signups, activation rate, W1 retention
2. `Growth and Funnel`
   - signup -> load -> save -> return conversion
3. `Editor Engagement`
   - uploads, revisions, editor sessions, save success/failure
4. `Catalog Engagement`
   - searches, views, comments, ratings, downloads by format
5. `Reliability`
   - 5xx, p95/p99, dependency failures, job failures

## Open Implementation Notes

- If anonymous catalog usage should be included in top-level KPIs, add a parallel `anonymous_*` dashboard section (do not mix with user-level retention).
- If `editor_sessions` is not yet explicit, derive provisional sessions via inactivity timeout (30 minutes) on editor events.
- Backend implementation details and local verification steps are tracked in `docs/observability/analytics-instrumentation-runbook.md`.
