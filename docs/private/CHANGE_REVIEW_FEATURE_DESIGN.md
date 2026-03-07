# Change Review Feature Design

## Status

Proposed design for a new Change Review workflow in OurTextScores.

## Goal

Add a review workflow where a reviewer can:

- open a review against a specific source change
- review the score change in a musical visual diff
- leave comments anchored to changed score regions
- submit the review
- notify the change owner on submit
- track their open reviews from a dedicated page

The design should fit the existing OurTextScores revision, branch, approval, comment, and notification model rather than introducing a parallel review system.

## Scope

This design covers:

- backend data model
- backend API contract
- frontend pages and flows
- notifications
- permissions
- lifecycle/state model

This design does not include implementation details for email copy, final visual styling, or migration strategy for historical backfill.

## Product Model

`Change Review` is a review artifact attached to an exact revision pair:

- `baseRevisionId`
- `headRevisionId`
- `workId`
- `sourceId`

The review is a structured, participant-scoped discussion over the diff between those two revisions.

The key distinction from existing revision comments:

- revision comments are general discussion on one revision
- change reviews are inline, diff-aware, participant-scoped, and have draft/submitted/open lifecycle

## Recommended V1 Boundaries

V1 should be intentionally narrow:

- review surface: score visual diff via the embedded score editor compare view
- commentable surface: changed score regions anchored to the reviewed diff pair
- one review targets one exact revision pair
- draft reviews are private
- submitted reviews notify the owner
- owner and reviewer can reply on review threads
- review stays open until explicitly closed or withdrawn

V1 should not attempt:

- automatic retargeting when branch head changes
- multi-reviewer assignment
- approvals replacement
- automatic mergeability or rebase logic

## Why A Separate Model

Do not extend `revision_comments` for this.

Reasons:

- `revision_comments` are attached to a single `revisionId`, not a diff pair
- they have no draft lifecycle
- they have no line anchors
- they assume broad revision discussion, not participant-scoped review threads
- current notification semantics are wrong for submitted reviews

Reuse should happen at the infrastructure level instead:

- comment rendering patterns
- notification inbox/outbox
- work/source identity
- revision visibility checks
- score-editor compare pipeline

## Implementation Correction

The review surface should be the musical score visual diff, not raw XML or text diff output.

That changes the intended architecture:

- `canonical.xml` remains a transport/input format for the compare renderer
- the user-facing review page should embed the score-editor compare view
- thread anchors should move from XML line anchors to score-aware anchors
- raw XML diff should be treated as an implementation fallback only, not the primary review experience

## Core Objects

### 1. `ChangeReview`

Collection: `change_reviews`

Purpose:

- review metadata
- review lifecycle
- participant identity
- exact diff target

Suggested shape:

```ts
{
  reviewId: string;
  workId: string;
  sourceId: string;
  branchName?: string;
  baseRevisionId: string;
  headRevisionId: string;
  baseSequenceNumber: number;
  headSequenceNumber: number;
  reviewerUserId: string;
  ownerUserId: string;
  participantUserIds: string[];
  title?: string;
  summary?: string;
  status: "draft" | "open" | "closed" | "withdrawn";
  unresolvedThreadCount: number;
  submittedAt?: Date;
  closedAt?: Date;
  closedByUserId?: string;
  closedReason?: "completed" | "withdrawn";
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended indexes:

- `{ reviewerUserId: 1, status: 1, lastActivityAt: -1 }`
- `{ ownerUserId: 1, status: 1, lastActivityAt: -1 }`
- `{ workId: 1, sourceId: 1, headRevisionId: 1, status: 1 }`
- unique partial index for reviewer drafts/open reviews on the same pair:
  - `{ reviewerUserId: 1, workId: 1, sourceId: 1, baseRevisionId: 1, headRevisionId: 1, status: 1 }`

### 2. `ChangeReviewThread`

Collection: `change_review_threads`

Purpose:

- one diff anchor
- one conversation on that anchor
- resolution state

Suggested shape:

```ts
{
  threadId: string;
  reviewId: string;
  workId: string;
  sourceId: string;
  fileKind: "canonical";
  diffAnchor: {
    side: "base" | "head";
    oldLineNumber?: number;
    newLineNumber?: number;
    anchorId: string;
    lineHash: string;
    lineText: string;
    hunkHeader?: string;
  };
  status: "open" | "resolved";
  createdByUserId: string;
  resolvedAt?: Date;
  resolvedByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended indexes:

- `{ reviewId: 1, createdAt: 1 }`
- `{ reviewId: 1, status: 1, updatedAt: -1 }`
- `{ reviewId: 1, "diffAnchor.anchorId": 1 }`

### 3. `ChangeReviewComment`

Collection: `change_review_comments`

Purpose:

- messages inside a review thread
- thread replies from reviewer or owner

Suggested shape:

```ts
{
  commentId: string;
  reviewId: string;
  threadId: string;
  userId: string;
  content: string;
  createdAt: Date;
  editedAt?: Date;
  deleted?: boolean;
  deletedAt?: Date;
}
```

Recommended indexes:

- `{ threadId: 1, createdAt: 1 }`
- `{ reviewId: 1, createdAt: 1 }`

## Review Target Semantics

Each change review is bound to an exact diff pair.

That means:

- line anchors are stable
- review comments remain attached to the exact change that was reviewed
- branch head updates do not silently move the review target

If a new commit lands on the branch after review creation:

- the existing review stays attached to the old `headRevisionId`
- UI should show `Newer branch head available`
- reviewer can start a new review for the newer head

This is a deliberate simplification. Automatic retargeting will make line anchoring and audit history much harder.

## Owner Resolution

The review owner should default to the person expected to respond to the requested changes.

Recommended resolution order:

1. explicit owner from the caller, if allowed
2. `headRevision.createdBy` when it is a real user
3. declared branch owner for `owner_approval` branches
4. source uploader from `source.provenance.uploadedByUserId`

This value should be persisted on the review at creation time.

If the source uploader differs from the resolved owner, the source uploader should still be added to `participantUserIds`.

## Permissions

### Create review

Allowed if:

- user is authenticated
- user can view both base and head revisions
- base and head belong to the same `workId/sourceId`
- base is older than head

### Read review

Draft:

- reviewer

Submitted/open/closed:

- reviewer
- owner
- optional additional participants recorded on the review

Recommended V1 default:

- keep reviews private to participants only

This avoids leaking editorial discussion into the public work page.

### Modify review

Draft:

- reviewer can add/edit/delete threads and comments

Open:

- reviewer can add new threads and reply
- owner can reply to existing threads
- reviewer or owner can resolve/unresolve threads
- only reviewer can close review
- reviewer can withdraw their own review

Closed/withdrawn:

- read-only

## Diff Anchoring

Line comments require a structured diff surface. Raw unified diff text is not enough.

### Recommendation

Add a structured diff endpoint for change review:

- `GET /api/change-reviews/diff?workId=:workId&sourceId=:sourceId&baseRevisionId=:base&headRevisionId=:head&file=canonical`

Response shape:

```ts
{
  fileKind: "canonical";
  baseRevisionId: string;
  headRevisionId: string;
  hunks: Array<{
    hunkId: string;
    header: string;
    lines: Array<{
      anchorId: string;
      type: "context" | "add" | "del";
      oldLineNumber?: number;
      newLineNumber?: number;
      content: string;
      commentable: boolean;
      lineHash: string;
    }>;
  }>;
}
```

Rules:

- only `add` and `del` lines are commentable in v1
- `context` lines render but cannot receive new threads
- `anchorId` should be deterministic for this diff pair

Suggested `anchorId` input:

- `fileKind`
- `hunk header`
- `oldLineNumber`
- `newLineNumber`
- normalized line content

The frontend should never invent anchors independently of the backend.

## API Design

## Backend Module Layout

Recommend a new backend module:

- `backend/src/change-reviews`

Reason:

- reviews are not only a works detail concern
- they need a global inbox/list page
- they have their own schemas, permissions, and notification behavior

The module can still depend on:

- `WorksService` for revision visibility checks
- `UsersService`
- `NotificationsService`

## Endpoints

### Create or resume a draft review

- `POST /api/works/:workId/sources/:sourceId/change-reviews`

Request:

```ts
{
  baseRevisionId: string;
  headRevisionId: string;
  ownerUserId?: string;
  title?: string;
}
```

Behavior:

- validates revision pair
- resolves owner
- returns existing draft/open review for same reviewer and pair if one already exists
- otherwise creates a new draft

### Get current user review index

- `GET /api/change-reviews`

Suggested query params:

- `role=reviewer|owner|all`
- `status=draft|open|closed|all`
- `limit`
- `cursor`

Response includes compact cards for the new `/change-reviews` page.

### Get review detail

- `GET /api/change-reviews/:reviewId`

Response includes:

- review metadata
- participants
- thread summaries
- permissions
- links to work/revisions

### Get structured diff for review

- `GET /api/change-reviews/:reviewId/diff`

Returns the structured canonical diff plus any thread counts per anchor.

### Add thread on changed line

- `POST /api/change-reviews/:reviewId/threads`

Request:

```ts
{
  anchorId: string;
  content: string;
}
```

Behavior:

- validates review is mutable
- validates anchor exists in review diff
- creates thread and first comment atomically
- increments unresolved count

### Reply in thread

- `POST /api/change-reviews/:reviewId/threads/:threadId/comments`

Request:

```ts
{
  content: string;
}
```

### Edit/Delete review comment

- `PATCH /api/change-reviews/:reviewId/comments/:commentId`
- `DELETE /api/change-reviews/:reviewId/comments/:commentId`

### Resolve or reopen thread

- `PATCH /api/change-reviews/:reviewId/threads/:threadId`

Request:

```ts
{
  status: "open" | "resolved";
}
```

### Submit review

- `POST /api/change-reviews/:reviewId/submit`

Request:

```ts
{
  summary?: string;
}
```

Behavior:

- requires reviewer
- requires at least one thread or non-empty summary
- transitions `draft -> open`
- sets `submittedAt`
- updates `lastActivityAt`
- notifies owner

### Close review

- `POST /api/change-reviews/:reviewId/close`

Request:

```ts
{
  reason?: "completed";
}
```

### Withdraw review

- `POST /api/change-reviews/:reviewId/withdraw`

Behavior:

- reviewer only
- sets status `withdrawn`

## Frontend UX

## Entry Points

### 1. Works page revision history

Add review actions near existing diff/open actions:

- `Start review`
- `Continue draft`
- `Open review`

The natural starting point is a revision pair already selected for diff.

Recommended behavior:

- from revision history or diff preview, user chooses `base` and `head`
- click `Start review`
- server creates/resumes draft
- user lands on dedicated review page

### 2. Global review inbox page

Add:

- `/change-reviews`

This page should be auth-required.

It should show three sections:

- `Needs your response`
  - `ownerUserId = currentUser`
  - `status = open`
- `Drafts`
  - `reviewerUserId = currentUser`
  - `status = draft`
- `Open by you`
  - `reviewerUserId = currentUser`
  - `status = open`

Each item should show:

- work title / source label
- branch name
- `#base -> #head`
- reviewer and owner usernames
- unresolved thread count
- last activity
- status badge
- direct link to review
- direct link back to work

### 3. Dedicated review page

Add:

- `/change-reviews/[reviewId]`

This page is the main review workspace.

Layout:

- header with work/source and revision pair
- status badge and owner/reviewer badges
- diff toolbar
- structured text diff with inline thread markers
- thread panel or inline expandable thread blocks
- submission footer for draft reviews

## Review Page Behavior

### Draft state

Reviewer can:

- add line comments
- edit/delete their draft comments
- write overall summary
- submit review

Owner should not see draft review unless explicitly changed later. Keep draft private in v1.

### Open state

Reviewer can:

- add more threads
- reply
- resolve/unresolve
- close review

Owner can:

- add new top-level threads
- reply
- resolve/unresolve

The open review page should show:

- unresolved thread count
- resolved thread count
- last activity
- if a newer branch head exists, a non-blocking banner with link to start a new review

### Closed/withdrawn state

Read-only timeline.

Closed and withdrawn reviews should remain discoverable from `/change-reviews` only, not from the works page.

## Notification Design

Reuse the existing inbox/outbox model in `notifications`.

### New notification type

Add:

- `change_review_submitted`

Inbox payload:

```ts
{
  reviewId: string;
  reviewerUserId: string;
  unresolvedThreadCount: number;
  baseRevisionId: string;
  headRevisionId: string;
}
```

Behavior:

- on `submit`, create in-app notification for `ownerUserId`
- if owner has email notifications enabled and transporter exists, include this in digest/immediate handling

Deep link:

- `/change-reviews/:reviewId`

### Optional later notification types

Not required for v1:

- `change_review_replied`
- `change_review_closed`

## Relationship To Existing Approvals

Change review should not replace branch approval.

The systems answer different questions:

- approvals decide whether a pending revision is accepted into visible history
- change reviews capture inline reviewer feedback on a specific diff

Recommended integration:

- on approvals inbox items, show a link to open existing change reviews for that head revision
- on works page, show count of open change reviews next to the revision if available

Neither integration is required for the first implementation pass.

## Relationship To Existing Revision Comments

Keep revision comments as public/general discussion on a revision.

Keep change reviews separate for:

- private draft review
- inline diff discussion
- owner notification on submit
- explicit open/closed lifecycle

No attempt should be made to merge these systems in v1.

## Suggested Frontend File Additions

Frontend:

- `frontend/app/change-reviews/page.tsx`
- `frontend/app/change-reviews/[reviewId]/page.tsx`
- `frontend/app/change-reviews/change-review-list.tsx`
- `frontend/app/change-reviews/change-review-detail.tsx`
- `frontend/app/change-reviews/change-review-diff.tsx`

Works page integration:

- `frontend/app/works/[workId]/revision-history.tsx`
- `frontend/app/works/[workId]/diff-preview.tsx`

Notifications:

- `frontend/app/notifications/notifications-client.tsx`

## Suggested Backend File Additions

Backend:

- `backend/src/change-reviews/change-reviews.module.ts`
- `backend/src/change-reviews/change-reviews.controller.ts`
- `backend/src/change-reviews/change-reviews.service.ts`
- `backend/src/change-reviews/schemas/change-review.schema.ts`
- `backend/src/change-reviews/schemas/change-review-thread.schema.ts`
- `backend/src/change-reviews/schemas/change-review-comment.schema.ts`

Notification updates:

- `backend/src/notifications/notifications.service.ts`
- `backend/src/notifications/schemas/inbox.schema.ts`
- `backend/src/notifications/schemas/outbox.schema.ts`

## Query and State Rules

### Open review calculation

A review is considered open when:

- `status = draft` or `status = open`

For the global page, draft and open should be separated visually.

### Unresolved thread count

Store and maintain `unresolvedThreadCount` on `ChangeReview`.

Reason:

- global page needs cheap sorting/filtering
- notification payload needs it
- avoids re-counting large thread sets for every list request

### Last activity

Update `lastActivityAt` on:

- thread creation
- comment reply
- resolve/unresolve
- submit
- close/withdraw

This should drive default sort order on `/change-reviews`.

## Implementation Order

1. Add backend schemas and service for review metadata, threads, and comments
2. Add review creation/detail/list endpoints
3. Add structured diff endpoint for review anchors
4. Add notification type and submit notification flow
5. Add `/change-reviews` index page
6. Add `/change-reviews/[reviewId]` detail page
7. Add works-page entry points into review creation
8. Add test coverage and smoke coverage

## Testing

### Backend

- review creation validates source and revision pair
- draft is private to reviewer/admin
- owner resolution falls back correctly
- thread creation only works on changed lines
- submit transitions draft to open
- submit sends `change_review_submitted`
- resolve/unresolve updates unresolved count
- list endpoint filters correctly for reviewer/owner/status

### Frontend

- `/change-reviews` renders drafts/open sections correctly
- review detail page renders structured diff and thread markers
- draft reviewer can add line comment and submit
- owner can open notified review and reply
- notifications page links `change_review_submitted` to review page

### Smoke

- reviewer starts draft from a work diff
- reviewer comments on a changed line
- reviewer submits review
- owner sees notification
- owner opens `/change-reviews/[reviewId]`
- owner replies and resolves one thread
- reviewer sees review in `Open by you`

## Resolved Product Decisions

1. The source uploader should always be added as an additional participant when different from the head revision author or resolved owner.
2. Owners may start new top-level threads after submit.
3. Closed reviews should remain discoverable only from `/change-reviews`, not from the works page.

## Implementation Plan

### Phase 1: Backend Foundation

1. Add `change_reviews`, `change_review_threads`, and `change_review_comments` schemas.
2. Add `ChangeReviewsModule` with service and controller wiring.
3. Add shared permission and revision-pair validation helpers.
4. Wire the module into `AppModule`.

Deliverable:

- backend can persist review metadata, threads, and comments
- no frontend integration yet

### Phase 2: Review Metadata APIs

1. Implement `POST /api/works/:workId/sources/:sourceId/change-reviews`
2. Implement `GET /api/change-reviews`
3. Implement `GET /api/change-reviews/:reviewId`
4. Add compact DTOs for review cards and review detail

Deliverable:

- reviewer can create or resume a draft review for a revision pair
- authenticated user can list and open their review records

### Phase 3: Structured Diff and Anchors

1. Add structured canonical diff generation for a revision pair
2. Implement `GET /api/change-reviews/:reviewId/diff`
3. Add backend anchor validation logic for thread creation

Deliverable:

- backend exposes stable, commentable changed-line anchors for review pages

### Phase 4: Review Threads and Comments

1. Implement `POST /api/change-reviews/:reviewId/threads`
2. Implement `POST /api/change-reviews/:reviewId/threads/:threadId/comments`
3. Implement comment edit/delete
4. Implement thread resolve/unresolve
5. Maintain `unresolvedThreadCount` and `lastActivityAt`

Deliverable:

- full review discussion lifecycle works on the backend

### Phase 5: Submit and Notification Flow

1. Add `change_review_submitted` notification type
2. Implement `POST /api/change-reviews/:reviewId/submit`
3. Implement `POST /api/change-reviews/:reviewId/close`
4. Implement `POST /api/change-reviews/:reviewId/withdraw`
5. Add notification deep link support to `/change-reviews/[reviewId]`

Deliverable:

- review submit notifies the owner and moves the review into the open state

### Phase 6: Frontend Review Pages

1. Add `/change-reviews`
2. Add `/change-reviews/[reviewId]`
3. Add review list cards for `Needs your response`, `Drafts`, and `Open by you`
4. Add structured diff view with inline thread markers and reply flows

Deliverable:

- end-to-end review UI exists independent of the works page

### Phase 7: Works Page Entry Points

1. Add `Start review` and `Open review` entry points from revision history and diff preview
2. Add draft/open state affordances for the current user on the relevant revision pair
3. Keep closed reviews off the works page

Deliverable:

- users can begin a review directly from the current revision comparison workflow

### Phase 8: Testing and Smoke Coverage

1. Add backend unit coverage for lifecycle, permissions, and notifications
2. Add frontend coverage for review list and detail flows
3. Add smoke coverage for create -> comment -> submit -> notify -> reply -> resolve

Deliverable:

- stable baseline for future review iterations

## Immediate Delivery Order

This implementation pass should proceed in this order:

1. backend schemas and module wiring
2. create/list/detail APIs
3. initial backend tests
4. structured diff endpoint
5. thread/comment APIs
6. submit/notification flow
7. frontend pages
8. works page entry points
