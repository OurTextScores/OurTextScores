# OurTextScores — AGENTS.md

This file orients future agents quickly: what the project does, how it’s wired, the key flows, and low‑effort improvements that keep momentum without thrash.

## Overview
- Purpose: Open, community‑driven platform for publishing and collaborating on machine‑readable music scores (MusicXML/MXL/MuseScore), with validation, derivative generation, diffs, search, and version history.
- Stack:
  - Backend: NestJS + Mongoose (MongoDB), MinIO (object storage), Fossil (per‑source VCS), MeiliSearch (full-text search). Python tools for IMSLP scraping and MusicXML linearization/diff.
  - Frontend: Next.js 14 (App Router) + Tailwind, OSMD for score rendering, diff2html for visual text diff.
  - Orchestration: Docker Compose (Mongo, MinIO, Meili, backend, frontend). Volumes for Fossil and data.

## Repo Layout
- `backend/` NestJS service exposing the API at `/api`.
  - Works domain: `src/works/**` (schemas, controller, services, derivative pipeline, uploads).
  - Storage: `src/storage/**` (MinIO client wrapper).
  - Fossil: `src/fossil/**` (per‑source repo creation/commit/diff/branches).
  - IMSLP: `src/imslp/**` (metadata cache + enrichment via Python and MediaWiki API).
  - Search: `src/search/**` (MeiliSearch integration for full-text work search, auto-indexing on create/update).
  - Progress: `src/progress/**` (SSE progress channel for uploads/pipeline).
  - Python helpers: `backend/python/linearize.py`, `backend/python/imslp_enrich.py`, `backend/python/musicdiff_pdf.py` used by pipeline/IMSLP service.
- `frontend/` Next.js app.
  - Works list: `app/page.tsx`.
  - Work detail: `app/works/[workId]/*` (upload new source/revision, viewers, diff preview, metadata editing, IMSLP refresh).
  - Upload flow: `app/upload/*` (select IMSLP work + file upload with SSE progress UI).
  - API client: `app/lib/api.ts`.
- `docker-compose.yml` Services (frontend, backend, mongo, meili, minio). Volumes under sibling dirs (`../*` from container perspective).
- `imslp_downloader.py` Stand‑alone downloader for batch scraping + metadata (not used by backend directly).
- `scripts/test_viewer.cjs` Quick headless check for OSMD rendering.

## How Things Work (Happy Path)
1. Ensure a Work
   - Frontend: Save IMSLP work via `POST /api/works/save-by-url` or `POST /api/works` (numeric id).
   - Backend (WorksService): validates and ensures `works` doc, fetches IMSLP metadata (ImslpService + Mongo `imslp` collection).
2. Upload Source / New Revision
   - Frontend opens SSE: `GET /api/works/progress/:id/stream`, posts `multipart/form-data` to:
     - New source: `POST /api/works/:workId/sources`
     - New revision: `POST /api/works/:workId/sources/:sourceId/revisions`
   - Backend stores raw file to MinIO, runs derivative pipeline, records Source + SourceRevision, optionally commits linearized/canonical/manifest to a per‑source Fossil repo, updates Work aggregate summary.
3. Derivative Pipeline (DerivativePipelineService)
   - Converts `.mscz` to `.mxl` (MuseScore CLI), extracts canonical XML from `.mxl`, generates linearized text (Python linearized-musicxml), attempts PDF, stores derivatives to MinIO, emits manifest with tool versions and checksums.
   - Asynchronously computes `musicdiff` for canonical XML changes between adjacent revisions and stores the report.
4. Viewing & Diff
   - Frontend lists works, shows source artifacts, renders canonical XML or normalized MXL with OSMD, previews PDF, and offers diffs (musicdiff semantic text or textual diffs for LMX/XML/manifest, including non‑adjacent revision pairs).
5. Search & Discovery
   - Works are automatically indexed in MeiliSearch when created, updated, or when sources/revisions are added.
   - Full-text search across title, composer, catalog number, and work ID with typo tolerance.
   - SearchService handles graceful degradation if MeiliSearch is not configured.
6. User Profile & Username
   - Users can set a unique username at `/settings` via `PATCH /api/users/me`.
   - When displaying work details, backend fetches usernames for all revision creators and includes `createdByUsername` in the response.
   - Revision history badges display username if set, otherwise fall back to userId.

## Data Model (Mongo)
- `Work`: `{ workId, latestRevisionAt?, sourceCount, availableFormats[], title?, composer?, catalogNumber? }`.
- `Source`: `{ workId, sourceId, label, sourceType, format, description?, originalFilename, isPrimary, storage, validation, provenance, derivatives?, latestRevisionId?, latestRevisionAt? }`.
- `SourceRevision`: `{ workId, sourceId, revisionId, sequenceNumber, fossilArtifactId?, fossilParentArtifactIds[], fossilBranch?, rawStorage, checksum, createdBy, createdAt, validationSnapshot, derivatives?, manifest?, changeSummary? }`.
- `User`: `{ email, username?, displayName?, emailVerifiedAt?, roles[], notify{watchPreference} }`. Username is unique, sparse index, lowercase, 3-20 chars (alphanumeric + underscores).
- `StorageLocator`: `{ bucket, objectKey, sizeBytes, checksum{algorithm,hexDigest}, contentType, lastModifiedAt }`.
- `DerivativeArtifacts`: optional locators for normalizedMxl, canonicalXml, linearizedXml, pdf, manifest, musicDiffReport.

## Environments & Config
- `.env` (checked in for dev):
  - Backend: `MONGO_URI`, `INTERNAL_API_URL`, `MINIO_URL` or `MINIO_{ENDPOINT,PORT,USE_SSL}`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `FOSSIL_PATH`, `MEILI_HOST`, `MEILI_MASTER_KEY`.
  - Frontend: `NEXT_PUBLIC_API_URL` (browser) and `INTERNAL_API_URL` (server) used by `app/lib/api.ts`.
- Docker volumes (host‑relative): `../mongo_data`, `../minio_data`, `../meilisearch_data`, `../fossil_data`.
- Tooling required in backend container: `musescore3`, `python3` packages `linearized-musicxml`, `musicdiff`, `imslp`, `PyPDF2`, and `fossil`.

## Run / Dev Quickstart
- Docker: `docker compose up -d` then open `http://localhost:3000` (UI) and `http://localhost:4000/api` (API).
- Local dev (frontend): `cd frontend && npm run dev` (ensure `NEXT_PUBLIC_API_URL` points to running backend).
- Local dev (backend): `cd backend && npm run start:dev` (Mongo + MinIO must be reachable; easiest via Docker compose).

## Key Endpoints

**Interactive API Documentation**: Swagger UI available at `http://localhost:4000/api-docs` with complete endpoint documentation, request/response schemas, and try-it-out functionality. OpenAPI JSON spec at `http://localhost:4000/api-docs-json`.

- Works
  - `GET /api/works?limit=...&offset=...` list works with pagination (default limit: 20, max: 100)
  - `POST /api/works` ensure by numeric id
  - `POST /api/works/save-by-url` ensure by IMSLP permalink/slug
  - `GET /api/works/:workId` details (sources + revisions)
  - `POST /api/works/:workId/metadata` update editable fields
  - Maintenance: `POST /api/works/:workId/sources/prune-pending`, `POST /api/works/:workId/sources/delete-all`
- Uploads (multipart/form-data, tag: `uploads`)
  - `POST /api/works/:workId/sources` new source (multipart with `file`, optional `description`, `commitMessage`)
  - `POST /api/works/:workId/sources/:sourceId/revisions` new revision (multipart; optional branch controls)
  - SSE progress: `GET /api/works/progress/:progressId/stream`
- Derivatives (tag: `derivatives`)
  - `GET /api/works/:workId/sources/:sourceId/{normalized.mxl|canonical.xml|score.pdf|linearized.lmx|manifest.json}` (optionally `?r=revisionId`)
- Diffs (tag: `diffs`)
  - `GET /api/works/:workId/sources/:sourceId/musicdiff.{txt|html|pdf}` (optionally `?r=revisionId`)
  - `GET /api/works/:workId/sources/:sourceId/musicdiff` on-demand diff (`revA`, `revB`, `format=semantic|visual`)
  - `GET /api/works/:workId/sources/:sourceId/textdiff` (`revA`, `revB`, `file=linearized|canonical|manifest`)
  - Fossil helpers: `GET /api/works/:workId/sources/:sourceId/fossil/{diff|branches}`
- IMSLP (tag: `imslp`, search: `search`)
  - `GET /api/imslp/search?q=...&limit=...` (also tagged `search`)
  - `POST /api/imslp/by-url` ensure by permalink (caches)
  - `GET /api/imslp/works/:workId` ensured metadata
  - `POST /api/imslp/works/:workId/refresh` refresh via Python helper
  - `GET /api/imslp/works/:workId/raw` raw cached doc (for debugging)
- Watches (tag: `watches`)
  - `POST /api/works/:workId/sources/:sourceId/watch` subscribe to notifications
  - `DELETE /api/works/:workId/sources/:sourceId/watch` unsubscribe
  - `GET /api/works/:workId/sources/:sourceId/watchers/count` count + user subscription status
- Branches (tag: `branches`)
  - `GET /api/works/:workId/sources/:sourceId/branches` list branches
  - `POST /api/works/:workId/sources/:sourceId/branches` create branch
  - `PATCH /api/works/:workId/sources/:sourceId/branches/:branchName` update branch settings
  - `DELETE /api/works/:workId/sources/:sourceId/branches/:branchName` delete branch
- Approvals (tag: `approvals`)
  - `GET /api/approvals/inbox?limit=...` pending revisions awaiting approval
  - `POST /api/works/:workId/sources/:sourceId/revisions/:revisionId/approve` approve pending revision
  - `POST /api/works/:workId/sources/:sourceId/revisions/:revisionId/reject` reject pending revision
- Users (tag: `users`)
  - `GET /api/users/me` current user profile (email, username, displayName, roles, notify preferences)
  - `PATCH /api/users/me` update user profile (username); validates format (3-20 chars, lowercase alphanumeric + underscores) and uniqueness
  - `PATCH /api/users/me/preferences` update notification preferences
- Auth (tag: `auth`)
  - `GET /api/auth/session` current session (user or null)
- Search (tag: `search`)
  - `GET /api/search/works?q=...&limit=...&offset=...&sort=...` full-text search across works (title, composer, catalog number, work ID)
  - `GET /api/search/health` MeiliSearch connection health status
  - `GET /api/search/stats` index statistics (document count, indexing status)

## Conventions
- Backend TypeScript: NestJS modules/services/controllers, DTOs kept lightweight. Prefer explicit return shapes for API.
- Mongo via Mongoose schemas (indexes declared in schemas). Consider `MONGO_AUTO_INDEX=true` in dev for index sync.
- Storage content types: `.mscz` → `application/vnd.musescore.mscz`, `.mxl` → `application/vnd.recordare.musicxml`, XML → `application/xml`, LMX → `text/plain`, PDF → `application/pdf`, manifest → `application/json`.
- Progress stages are used by UI steppers; keep them stable when changing pipeline steps.
- Frontend: App Router pages under `app/`; fetch server‑side via `app/lib/api.ts`. Use Tailwind for styling, keep components server‑first; hydrate only where needed.

### API base usage (client vs server)
- Server components and server actions should use `getApiBase()` (internal base resolves to `http://backend:4000/api` in Docker) for server→backend fetches.
- Client components and any browser‑visible hrefs must use `getPublicApiBase()` so URLs point to the public base (e.g. `http://localhost:4000/api`).
- Guards enforce this:
  - Prebuild: fails if a `"use client"` file imports/uses `getApiBase()`.
  - Postbuild: scans the built bundle to ensure no `backend:4000` URLs leak into client code.

### Upload proxy + auth
- Browser uploads must go through Next.js proxy routes so Authorization is attached:
  - `POST /api/proxy/works/:workId/sources`
  - `POST /api/proxy/works/:workId/sources/:sourceId/revisions`
- The proxies forward the original multipart body and set `duplex: 'half'` for Node fetch streaming.
- Always include `X-Progress-Id` for SSE correlation (see SSE section).

### Branch policies and lists
- Branch types: Open and "Owner approval required" (immutable after creation). UI does not allow switching type.
- Owned branches require authentication; uploads land as `pending_approval` and are hidden from anonymous users.
- Declared branches API is the source of truth for selecting branches in the UI; don’t rely on Fossil branches until a commit exists.

### SSE progress
- SSE endpoint: `GET /api/works/progress/:progressId/stream` (server‑sent events).
- Correlate uploads with `X-Progress-Id` header; the backend publishes stable stages (e.g., `upload.received`, `pipeline.start`, `fossil.*`, `db.*`, `done`). Keep names stable for UI.

## Known Gotchas
- Ensure `NEXT_PUBLIC_API_URL` includes `/api` path; several components default to `http://localhost:4000/api` but a few fallback constants omit `/api` if env is absent. Prefer setting env.
- MuseScore CLI requires headless Qt (`QT_QPA_PLATFORM=offscreen` set in Dockerfile).
- Large files: upload limit set to 100MB. MinIO must be reachable from backend.
- `.next/` (frontend) and `node_modules/` should not be committed; they’re ignored but may exist locally.
- Client code must not leak internal hosts (e.g. `http://backend:4000`). Use `getPublicApiBase()` for browser URLs; the build guards will fail otherwise.
- When forwarding streaming bodies with Node fetch (proxying multipart), set `duplex: 'half'`.
- If declared branches don’t appear in client dropdowns immediately, ensure the page is refreshed or the server side passes `initialBranches` derived from the branches API.
- Make sure to rebuild the docker containers before testing: `docker compose up -d --build`

## Testing & CI

### Expectations for features
- New features must include:
  - Unit tests (backend services/controllers; simple frontend utilities when applicable).
  - Smoke test coverage for the critical happy path(s) (see suite below).
- When developing new features, run a Docker build for the frontend and the smoke tests locally before commiting the changes.

### Unit tests
- Backend uses Jest (see `*.spec.ts`). Prefer testing services in isolation with fakes/mocks for I/O.
- Keep tests fast and deterministic; avoid real network and storage where possible.
- How to run locally: `npm run test:unit`

### Smoke tests (Playwright)
- Location: `smoke/e2e/*.spec.cjs` (Chromium).
- How to run locally:
  - `npm run smoke:up` (build images, start stack, wait for health)
  - `npm run smoke:install` (first time: installs browsers)
  - `npm run smoke:run` (runs the suite)
  - `npm run smoke:down` (teardown)
  - `npm run docker:clean` (thorough cleanup: removes volumes and orphaned containers)
  - `npm run smoke:status` (check Docker container status and resource usage)
  - `npm run smoke` (cleanup, build, install, run, cleanup — full cycle with memory management)
  
- Current coverage:
  - `auth-email.spec.cjs` — NextAuth Email sign‑in via Mailpit; can access Approvals.
  - `public-links.spec.cjs` — health endpoints; all browser hrefs use the public API base and at least one artifact resolves 200.
  - `sse-progress.spec.cjs` — opens SSE stream and asserts progress events during an upload.
  - `branch-approvals.spec.cjs` — creates an Owned branch (API), uploads a revision (API), Approvals grows, approves, revision history filter includes the branch.
  - `viewers-diff-watch.spec.cjs` — OSMD/PDF viewers render; diff UI or direct textdiff API returns content; Watch toggle works.
  - `username-profile.spec.cjs` — user sets username in settings, sees success feedback, username appears in revision badges; validates uniqueness and format.

### CI (Docker + Playwright)
- Workflow: `.github/workflows/smoke.yml`.
- Jobs:
  - `smoke-fast`: runs quick tests (health, public links, email auth, SSE progress). These are the default tests that must pass for all changes.
  - `smoke-slow`: heavier flows (branch approvals, viewers/diff). Run on demand (e.g., by maintainers, nightly, or pre‑release); not mandatory for every change unless explicitly requested.
- Both jobs build Docker images, bring up the stack, wait for health, install Playwright, run tests, upload traces on failure, and teardown containers.

### Build‑time guards
- Prebuild (`frontend/scripts/check_client_api_usage.cjs`): fails if any `"use client"` file uses `getApiBase()`.
- Postbuild (`frontend/scripts/verify_public_links.cjs`): fails if the built client bundle contains `backend:4000` URLs.

## Diagnostics & OAuth
- Diagnostics endpoint: `GET /api/diagnostics/email` (checks SMTP + Mongo connectivity and returns `ok`).
- Email provider (NextAuth) requires Mongo adapter; ensure `MONGO_URI`, `NEXTAUTH_SECRET`, `EMAIL_SERVER`, `EMAIL_FROM`, `NEXTAUTH_URL` are set.
- Optional OAuth: Google/GitHub providers enabled via env; see `docs/OAUTH_SETUP.md` for setup.

## Current Implementation Status

### ✓ Fully Implemented & Working
- **Core Upload/Revision Workflow**: Work creation, source uploads, revision management, derivative pipeline - complete end-to-end
- **Authentication & Authorization**: NextAuth (Email + optional OAuth via Google/GitHub), JWT tokens for API, auth guards (required/optional), role-based checks
- **User Profile & Username**: Users can set unique usernames (3-20 chars, lowercase alphanumeric + underscores); usernames displayed in revision badges instead of user IDs; `PATCH /api/users/me` endpoint with validation and duplicate checking; settings UI with real-time save feedback
- **Branching System**: Public and owner-approval branches with policy enforcement; branch policy immutable after creation
- **Approvals Workflow**: Complete with approve/reject endpoints (`works.controller.ts:653-673`), inbox API, status transitions, watcher notifications
- **Notifications**: Outbox pattern with actual email delivery via NodeMailer; supports immediate + digest (daily/weekly); Mailpit for dev testing
- **Watches**: Users can follow sources; notifications sent to watchers on new revisions
- **Fossil VCS Integration**: Per-source repositories with commit, branch support, artifact tracking, parent chain
- **IMSLP Integration**: Metadata fetching, MongoDB caching, enrichment via MediaWiki API + Python `imslp_enrich.py`
- **Derivative Pipeline**: MuseScore conversion (.mscz → .mxl), canonical XML extraction, linearization (Python), musicdiff, PDF generation
- **Diff Viewers**: Text diffs (linearized/canonical/manifest via diff2html) and musicdiff semantic comparisons; supports non-adjacent revision pairs
- **Progress Tracking**: SSE streams (RxJS Subjects) for real-time upload progress with stable stage names
- **Storage (MinIO)**: Three bucket patterns (raw, derivatives, auxiliary) with auto-creation, checksums, content-type handling
- **Health & Diagnostics**: Health check endpoints, email connectivity diagnostics (`/api/diagnostics/email`)
- **API Documentation**: Comprehensive Swagger/OpenAPI documentation via `@nestjs/swagger` decorators; 54 endpoints documented across 12 tags (uploads, derivatives, diffs, search, approvals, auth, branches, health, imslp, users, watches, works); interactive API explorer at `/api-docs`
- **Pagination**: List endpoints (`GET /api/works`) support `limit` and `offset` for pagination.

### ⚠️ Partially Implemented
- **Validation Pipeline**: Schema and structure exist in `validation.schema.ts` but actual validation is stub; all revisions pass by default
- **User Roles**: Schema has `roles[]` field and basic admin checks exist, but enforcement is not comprehensive across all endpoints
- **Error Handling**: Basic `HttpErrorFilter`; lacks retry logic, circuit breakers, graceful degradation for external services
- **Monitoring & Logging**: Uses NestJS Logger; no structured logging (JSON), no metrics collection (Prometheus), no alerting

### 🔴 Next Steps

3. **Rate Limiting**
   - No rate limiting on any endpoints
   - No throttling on auth, upload, or expensive operations
   - **Impact**: Vulnerable to abuse/DoS

4. **Caching Layer**
   - No caching for IMSLP metadata, work summaries, or derivative artifacts
   - Every request hits MongoDB or external APIs
   - **Impact**: Higher latency, more load on external services

5. **Advanced Fossil Features**
   - Fossil diff/log/timeline not exposed via API (only branches endpoint exists)
   - No merge/conflict resolution
   - No UI for branch visualization
   - **Impact**: Limited version history exploration

### Testing Coverage Assessment
- **Backend Unit Tests**: 372 tests across 22 suites
  - Statements: 69.71% (1588/2278)
  - Branches: 57.32% (1013/1767)
  - Functions: 60.3% (199/330)
  - Lines: 70.17% (1445/2059)
- **Frontend Unit Tests**: 182 tests across 22 suites
  - Statements: 75.12% (779/1037)
  - Branches: 59.6% (394/661)
  - Functions: 73.12% (166/227)
  - Lines: 76.09% (729/958)
- **E2E Smoke Tests**: 6 test suites (auth-email, public-links, sse-progress, branch-approvals, viewers-diff-watch, username-profile)
- **CI/CD**: GitHub Actions with smoke-fast (45min timeout) + smoke-slow (60min timeout) jobs
- **Build Guards**: Prebuild (`check_client_api_usage.cjs`) + postbuild (`verify_public_links.cjs`) prevent API URL leaks
- **Overall Test Health**: 554 unit tests passing, 6 smoke test suites, ~70-76% code coverage across backend/frontend

### Known Technical Debt
1. **Large Service Files**: `DerivativePipelineService` (250+ lines), `WorksService` (614 lines) - could decompose
2. **Limited Input Validation**: Controllers mostly rely on schema validation; lacks middleware for sanitization
3. **Generic Error Messages**: Some errors don't expose details (good for security, hard for debugging)
4. **Hardcoded Timeouts**: 60s for MuseScore subprocess, 10s for notification polling
5. **Python Subprocess Errors**: Not always gracefully handled; can leave incomplete records
6. **No Deadletter Queue**: Failed notifications retry indefinitely or mark error; no DLQ pattern
7. **No Request/Response Logging**: Hard to debug issues in production without request tracing

## Next Steps & Priorities

### High Priority (MVP Completion)
1. **Improve Error Handling & Resilience**
   - Retry logic with exponential backoff (IMSLP API, email delivery)
   - Better error messages with request IDs
   - **Estimated effort**: 2-3 days

2. **Add Monitoring & Observability**
   - Structured logging (JSON format with Winston or Pino)
   - Metrics collection (Prometheus client)
   - Enhanced health checks (MongoDB, MinIO, MeiliSearch dependency checks)
   - **Estimated effort**: 2-3 days

3. **Add Rate Limiting**
   - Express rate limiter middleware
   - Per-user rate limits (authenticated)
   - Per-IP rate limits (anonymous)
   - **Estimated effort**: 1 day

4. **Advanced Fossil Features**
   - Expose diff/log/timeline endpoints
   - Branch merge/conflict resolution
   - Blame/annotate views
   - **Estimated effort**: 3-5 days


## Architecture Decisions & Patterns

### Per-Source Fossil Repositories
Each source gets its own `.fossil` file (e.g., `/data/fossil_data/{workId}/{sourceId}.fossil`) rather than a monolithic repo.
- **Rationale**: Enables independent branching per source, cleaner separation, simpler access control
- **Trade-off**: More filesystem overhead but better isolation and scalability
- **Implementation**: `fossil.service.ts:40-60`

### Linearized XML for Diffs
Uses `linearized-musicxml` Python package to convert MusicXML to line-oriented text before diffing.
- **Rationale**: More human-readable diffs than XML tree diffs; better semantic comparisons with `musicdiff`
- **Trade-off**: Additional processing step but significantly better UX
- **Implementation**: `derivative-pipeline.service.ts:150-180`, `backend/python/linearize.py`

### Dual API Base URLs
- `getApiBase()` returns `http://backend:4000/api` (internal Docker hostname for SSR)
- `getPublicApiBase()` returns `http://localhost:4000/api` (public URL for browser)
- Build guards prevent leakage of internal URLs to client bundle
- **Rationale**: Docker networking requires internal hostname for server-side fetches but public URL for browser
- **Implementation**: `frontend/app/lib/api.ts:10-25`, `frontend/scripts/*.cjs`

### Outbox Pattern for Notifications
Notifications queued in MongoDB (`NotificationOutbox` collection), processed by polling worker (10s interval).
- **Rationale**: Decouples event publishing from delivery; enables retry, digest aggregation (daily/weekly)
- **Trade-off**: Eventual consistency (up to 10s delay) but better reliability
- **Implementation**: `notifications.service.ts:68-134`

### Branch Policy Immutability
Branch types (public vs owner-approval) cannot be changed after creation.
- **Rationale**: Prevents security issues from retroactive policy changes; clearer semantics
- **Trade-off**: Less flexibility but no confusion about approval requirements
- **Implementation**: `branches.service.ts`, UI disables policy dropdown after creation

### Manifest Files for Traceability
Each revision includes `manifest.json` with tool versions, checksums, timestamps.
- **Rationale**: Enables reproducibility, debugging derivative generation issues
- **Example**: `{"musescoreVersion": "3.6.2", "linearizedMusicxmlVersion": "0.10.5", "sha256": "...", "generatedAt": "..."}`
- **Implementation**: `derivative-pipeline.service.ts:200-230`

## Operational Considerations

### Resource Requirements (Docker Deployment)
- **MongoDB**: Moderate storage (~100MB for 1000 works with metadata); indexes on `workId`, `sourceId`, `userId`
- **MinIO**: Scales linearly with uploaded files (raw + derivatives); ~2-5x raw file size for all derivatives
- **Fossil**: One `.fossil` file per source; lightweight (typically <1MB per source); linear growth
- **MeiliSearch**: Not yet utilized; will require ~1-2x index size of corpus (estimate 500MB for 10K works)
- **Backend Memory**: MuseScore subprocess memory-intensive for large scores (can spike to 500MB+)
- **Frontend**: Static site; minimal runtime overhead

### Scaling Considerations
- **Upload Processing**: Currently synchronous; consider async job queue (Bull/BullMQ) for high volume
- **Derivative Pipeline**: Sequential processing; could parallelize steps (PDF generation independent of linearization)
- **Fossil Operations**: File-based locking; consider sharding by `workId` prefix for large deployments
- **Database**: MongoDB sharding possible but not required for <100K works
- **Storage**: MinIO supports distributed mode for high availability

### Common Development Pitfalls
1. **Stale Docker Images**: Forgetting to rebuild after dependency changes (`docker compose build backend frontend`)
2. **API URL Leaks**: Using `getApiBase()` in client components (prebuild guard catches this)
3. **Missing Progress ID**: Not setting `X-Progress-Id` header breaks SSE correlation
4. **Branch Assumption**: Assuming Fossil branch exists before first commit (branches API is source of truth)
5. **Qt Requirement**: MuseScore requires `QT_QPA_PLATFORM=offscreen` in headless environments (set in `backend/Dockerfile`)
6. **Multipart Streaming**: Forgetting `duplex: 'half'` when proxying uploads causes errors

### Development Workflow Tips
- **Local Full Stack**: `docker compose up -d` → http://localhost:3000 (UI), http://localhost:4000/api (API)
- **Backend Hot Reload**: `cd backend && npm run start:dev` (requires Mongo/MinIO running via Docker)
- **Frontend Dev Server**: `cd frontend && npm run dev` (ensure `NEXT_PUBLIC_API_URL=http://localhost:4000/api`)
- **Run All Tests**: `cd backend && npm test` (unit) + `cd frontend && npm test` (unit) + `npm run smoke` from root (E2E)
- **Check Build Guards**: `cd frontend && npm run prebuild && npm run build && npm run postbuild`
- **View Logs**: `docker compose logs -f backend` or `docker compose logs -f frontend`
- **Check Docker Resources**: `npm run smoke:status` (shows running containers and memory/CPU usage)
- **Clean Docker Artifacts**: `npm run docker:clean` (removes containers, volumes, and orphaned resources; use before smoke tests if experiencing memory issues)
- **Reset State**: `docker compose down && rm -rf ../mongo_data ../minio_data ../fossil_data ../meilisearch_data` (destructive, check with user before executing)

