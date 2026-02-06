# Projects Feature Detailed Design

**Status**: Proposed  
**Date**: 2026-02-06  
**Owners**: Backend + Frontend

## Overview

Add a collaborative `Projects` feature for organizing source-finding and source-creation work.

The feature introduces:
- A projects index page listing all projects.
- A project detail page with lead, members, description, and a collaborative editable row table.
- Row-level actions to create internal sources from external score links.
- Source badges showing project membership.

This design is aligned to current stack and conventions:
- Backend: NestJS + Mongoose + existing Works upload/create flows.
- Frontend: Next.js App Router + server-first pages + client components for editable tables.

## Product Decisions Confirmed

1. A source can belong to multiple projects.
2. `verified` is reversible and can be changed by source owner, project lead, and admin users.
3. `hasReferencePdf` is manually controlled on project rows (no automatic inference from source artifacts).

## Goals

- Let teams track candidate sources in one place before and after import.
- Keep row editing simple and collaborative for project members.
- Preserve traceability from project row to internal source.
- Make project affiliation visible where sources are shown.

## Non-Goals (MVP)

- No project-specific branching workflow.
- No automatic IMSLP metadata scraping into rows beyond URL validation.
- No bulk import/create actions (single-row create action only).
- No hard real-time collaborative cursor editing; use row-level optimistic updates.

## User Roles and Permissions

### Roles

- `Lead`: single user designated on project; can manage members and all rows.
- `Member`: can edit project details (except lead assignment), add/edit/delete rows, run create-source action.
- `Viewer`: authenticated or public read-only access (policy configurable, see below).
- `Admin`: global admin role from `users.roles[]`; full access across all projects.

### Permission Matrix

- Create project: authenticated user.
- Edit project metadata (name/description): lead or admin.
- Manage members: lead or admin.
- Add/edit/delete rows: members, lead, admin.
- Create internal source from row: members, lead, admin.
- Toggle row `verified`: source owner, project lead, admin.
- Toggle row `hasReferencePdf`: members, lead, admin.

## Data Model

## `Project` collection

```ts
{
  projectId: string;                 // short stable id (e.g., "prj_x7a2m9")
  slug: string;                      // unique URL slug
  title: string;
  description: string;
  leadUserId: string;
  memberUserIds: string[];           // does not include lead by requirement; include in computed access check
  visibility: 'public' | 'private';  // MVP default: public
  status: 'active' | 'archived';
  rowCount: number;                  // denormalized
  linkedSourceCount: number;         // denormalized
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes:
- `{ projectId: 1 }` unique
- `{ slug: 1 }` unique
- `{ leadUserId: 1, status: 1 }`
- `{ memberUserIds: 1, status: 1 }` multikey
- `{ updatedAt: -1 }`

## `ProjectSourceRow` collection

```ts
{
  projectId: string;
  rowId: string;                     // stable row id for UI + linking

  externalScoreUrl?: string;         // arbitrary score source URL
  imslpUrl?: string;                 // IMSLP work/permalink URL

  linkedWorkId?: string;             // set after internal source creation
  linkedSourceId?: string;           // set after internal source creation
  linkedRevisionId?: string;         // first created revision (optional)

  hasReferencePdf: boolean;          // manual checkbox only
  verified: boolean;                 // reversible
  verifiedAt?: Date;
  verifiedBy?: string;               // userId

  notes?: string;

  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;

  rowVersion: number;                // optimistic concurrency token
}
```

Indexes:
- `{ projectId: 1, rowId: 1 }` unique
- `{ projectId: 1, updatedAt: -1 }`
- `{ linkedSourceId: 1 }`
- `{ imslpUrl: 1 }` sparse

## Source schema extension

Add to `Source` schema:

```ts
{
  projectIds?: string[];             // many-to-many project affiliation
  projectLinkCount?: number;         // optional denormalized count for quick badge text
}
```

Indexes:
- `{ projectIds: 1 }` multikey

Rationale:
- Enables fast source badge rendering and filter queries.
- Keeps row-level details in `ProjectSourceRow`; source only stores affiliation IDs.

## API Design

Tag: `projects`

## Project endpoints

- `GET /api/projects?limit=&offset=&status=&q=`
  - Returns paginated project summaries.
- `POST /api/projects`
  - Create project.
  - Body: `{ title, slug?, description, leadUserId?, memberUserIds?, visibility? }`
- `GET /api/projects/:projectId`
  - Returns project metadata + members + summary counters.
- `PATCH /api/projects/:projectId`
  - Update metadata (`title`, `description`, `status`, `visibility`, `leadUserId`).
- `PATCH /api/projects/:projectId/members`
  - Body: `{ addUserIds?: string[], removeUserIds?: string[] }`
- `DELETE /api/projects/:projectId`
  - Soft-delete/archive in MVP (`status=archived`).

## Row endpoints

- `GET /api/projects/:projectId/rows?limit=&offset=`
  - Paginated rows for project table.
- `POST /api/projects/:projectId/rows`
  - Add row.
  - Body: `{ externalScoreUrl?, imslpUrl?, hasReferencePdf?, notes? }`
- `PATCH /api/projects/:projectId/rows/:rowId`
  - Partial row update with optimistic concurrency.
  - Body includes `rowVersion` and updated fields.
- `DELETE /api/projects/:projectId/rows/:rowId`
  - Delete row.

## Row action endpoint

- `POST /api/projects/:projectId/rows/:rowId/create-source`
  - Creates internal source from row link.
  - Body:
    ```ts
    {
      workId?: string;               // preferred when known
      imslpUrl?: string;             // fallback to row.imslpUrl
      sourceLabel?: string;
      sourceType?: 'user_upload' | 'imslp_derived' | 'reference';
      commitMessage?: string;
      externalFileUrl?: string;      // optional for later extension
    }
    ```
  - Response:
    ```ts
    {
      ok: true,
      workId: string,
      sourceId: string,
      revisionId?: string,
      row: { rowId, linkedWorkId, linkedSourceId, linkedRevisionId, rowVersion }
    }
    ```

Implementation detail for MVP:
- Initial version can require user to upload file in existing upload flow after source shell creation, if remote file ingestion is not enabled yet.
- If remote URL ingestion exists later, this endpoint can create source + initial revision directly.

## Badge and source association endpoint (optional)

- `GET /api/works/:workId/sources/:sourceId/projects`
  - Returns project badges metadata: `[ { projectId, slug, title } ]`.

If `Source.projectIds` is included in existing source detail payload, this extra endpoint can be skipped.

## Validation Rules

- `externalScoreUrl` and `imslpUrl` must be valid absolute `http`/`https` URLs.
- `imslpUrl` normalized (trim, canonical protocol/host casing).
- Prevent duplicate rows in same project where normalized (`externalScoreUrl`, `imslpUrl`) pair matches existing row.
- `notes` max length (e.g., 2000 chars).
- `rowVersion` required for `PATCH`; mismatch returns `409 Conflict`.

## Authorization Rules

- Read project/list:
  - `public` projects readable by all.
  - `private` projects readable by lead, members, admin.
- Project edits/member management:
  - lead or admin.
- Row edits/add/delete/create-source:
  - lead, member, admin.
- `verified` toggle:
  - allowed if actor is source owner OR project lead OR admin.
  - source owner defined as `Source.provenance.uploadedByUserId`.

## Frontend Design

## Routes

- `frontend/app/projects/page.tsx`
  - Projects list with pagination, search, status filter.
- `frontend/app/projects/[projectId]/page.tsx`
  - Project detail container (server component).
- `frontend/app/projects/[projectId]/project-rows-table.tsx`
  - Client component for inline row editing and row actions.

## Project List Page

Columns/cards:
- Title (link)
- Lead username
- Member count
- Row count
- Linked source count
- Last updated
- Status

Primary actions:
- `Create Project`
- `Open`

## Project Detail Page

Sections:
- Header: title, status, lead badge, member avatars/list.
- Description panel (editable by lead/admin).
- Rows table.

Table columns:
- External source score URL (editable text/url field)
- IMSLP page URL (editable text/url field)
- Internal source action cell:
  - Button `Create internal source` when not linked
  - Link to internal source when linked
- `Has reference PDF` checkbox (manual)
- `Verified` checkbox (permission-gated)
- Notes (editable text area)
- Row actions (`Delete`)

Behavior:
- `Add Row` button inserts draft row and focuses first editable cell.
- Per-row save on blur or explicit save action.
- Inline validation errors at cell level.
- Optimistic updates; on `409`, reload row and show conflict toast.

## Source Badge UX

Where source cards/revision lists are shown:
- Show `Project` badge(s) for each associated project.
- Badge text: project title or short slug.
- Badge click opens `/projects/:projectId`.
- If multiple projects, show first 2 + `+N` overflow indicator.

## Backend Architecture Integration

## New module

- `backend/src/projects/`
  - `projects.module.ts`
  - `projects.controller.ts`
  - `projects.service.ts`
  - `schemas/project.schema.ts`
  - `schemas/project-source-row.schema.ts`
  - DTOs for create/update/patch/action

## Existing module updates

- `backend/src/works/schemas/source.schema.ts`
  - Add `projectIds`, `projectLinkCount`.
- `backend/src/works/works.service.ts`
  - Include project affiliations in source detail response.
- `backend/src/search/search.service.ts` (optional phase)
  - Add project-related searchable fields later if needed.

## Create-source workflow integration

For `create-source` action:
1. Validate row and permissions.
2. Resolve/ensure target work:
   - Prefer explicit `workId`.
   - Else derive from `imslpUrl` using existing ensure-by-url flow.
3. Create internal source record (or source shell).
4. Link row to created source ids.
5. Update `Source.projectIds` with `$addToSet`.
6. Update denormalized counters (`rowCount`, `linkedSourceCount`, `projectLinkCount`).

## Concurrency and Audit

- Every row update includes `rowVersion` in request.
- Server updates with conditional query:
  - `findOneAndUpdate({ projectId, rowId, rowVersion }, { ...$set, $inc: { rowVersion: 1 } })`
- Audit fields always set: `updatedBy`, `updatedAt`.

## Error Handling

- `400`: validation errors (bad URL, invalid fields).
- `403`: unauthorized row/project operation.
- `404`: project or row not found.
- `409`: concurrency conflict or duplicate row URL pair.
- `422`: create-source action missing required linked data (no usable URL/work mapping).

## OpenAPI/Swagger

- Add `projects` tag and document all endpoints.
- Include examples for row patch and create-source action.
- Reuse auth decorators (`AuthRequiredGuard`, optional where read-only allowed).

## Migration and Backward Compatibility

- No destructive migrations.
- `Source.projectIds` optional, defaults absent/empty.
- Existing sources without affiliations render no badges.
- Existing works/source endpoints remain backward compatible.

## Testing Strategy

## Backend unit tests

- Project CRUD permissions.
- Member management.
- Row create/patch/delete validation and duplicate checks.
- `rowVersion` conflict behavior (`409`).
- `verified` toggle permissions:
  - source owner allowed
  - lead allowed
  - admin allowed
  - regular member denied if not source owner
- `create-source` links row and updates `Source.projectIds`.

## Frontend tests

- Projects list renders summaries.
- Project detail table renders editable cells.
- Add row + patch row success path.
- Conflict handling UI on `409`.
- Conditional rendering for `Create internal source` button vs source link.
- Badge rendering with overflow `+N`.

## Smoke/E2E tests (Playwright)

Add `smoke/e2e/projects.spec.cjs`:
- Create project as authenticated user.
- Add member and row.
- Edit external/IMSLP URLs and notes.
- Create internal source from row and verify source link appears.
- Verify source shows project badge.
- Verify/revoke `verified` by:
  - lead
  - admin
- Confirm unauthorized user cannot toggle verification.

## Implementation Plan

## Phase 1: Backend foundation

1. Add `projects` module + schemas + CRUD endpoints.
2. Add row endpoints with optimistic concurrency.
3. Add create-source action endpoint (source shell + linking).
4. Extend `Source` schema with `projectIds`.
5. Add permissions and unit tests.

## Phase 2: Frontend MVP UI

1. Add `/projects` list page.
2. Add `/projects/[projectId]` detail page.
3. Build editable rows table with per-row save.
4. Wire create-source action + linked source display.
5. Add source badge rendering in work/source views.

## Phase 3: Hardening

1. Add E2E smoke coverage.
2. Add pagination/search improvements on projects list.
3. Optional: project-related indexing/search facets.

## Risks and Mitigations

- Risk: Row edit conflicts in active projects.
  - Mitigation: row-level version checks + conflict reload UX.
- Risk: Unclear create-source behavior if no ingestable file path.
  - Mitigation: explicit MVP behavior in endpoint response and UI messaging.
- Risk: Permission drift between project and source ownership rules.
  - Mitigation: central helper for authorization checks with dedicated tests.

## Suggested Defaults (MVP)

- `visibility`: `public`
- `status`: `active`
- Page size: `20` projects, `50` rows
- Max members per project: `100`
- Max notes length: `2000`

## Future Extensions

- Project notifications (watch a project).
- Bulk CSV import of rows.
- Row status enum (`candidate`, `imported`, `blocked`, `verified`).
- Project activity feed/audit log UI.
- Per-project filters for `hasReferencePdf` and `verified`.
