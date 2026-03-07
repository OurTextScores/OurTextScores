# Change Review Feature Design

## Status

Current design. This replaces the earlier revision-pair draft review model.

## Goal

Add a Change Review workflow where:

- one CR exists per reviewable branch
- the CR is a shared discussion space for that branch
- new branch revisions extend the same CR as new patchsets
- comments live in the score visual diff gutter
- closing the CR closes the branch to new revisions
- reopening the CR reopens the branch
- `owner_approval` branches are excluded from CR entirely

## Core Decisions

1. CR identity is `workId + sourceId + branchName`.
2. There is exactly one CR per reviewable branch.
3. CR supports multiple revisions via patchsets.
4. Any authenticated user who can view the branch may open the CR and comment on it.
5. The branch owner controls CR close/reopen.
6. Closing a CR closes the branch to new revisions.
7. Reopening a CR reopens the branch.
8. `owner_approval` branches do not participate in CR.

## Why This Model

The earlier `baseRevisionId -> headRevisionId` review model is too narrow:

- it does not support real review across multiple revisions
- it fragments discussion when follow-up commits land
- it makes thread resolution artificial
- it does not fit a one-CR-per-branch workflow

Branch identity plus patchsets is the correct model because review is about a line of work, not one frozen diff forever.

## Product Model

### Reviewable Branches

Only reviewable branches can participate in CR:

- `public` branches: eligible
- `owner_approval` branches: not eligible

Rules:

- no `Start CR` or `Open CR` actions for `owner_approval` branches
- score editor must hide `Open CR` for revisions on `owner_approval` branches
- CR create/open endpoints must reject `owner_approval` branches

Recommended error:

```ts
{
  error: "branch_not_reviewable",
  branchName: "feature-a",
  policy: "owner_approval"
}
```

### One CR Per Branch

Each reviewable branch has one CR record.

That CR may be:

- `open`
- `closed`

There is no private draft state in this model.

If a user tries to open a CR for a branch that already has one, the system returns the existing CR.

If users want a separate review conversation, they should create a new branch.

### Shared Review Space

The CR is not reviewer-owned. It is a shared review space for the branch.

Allowed actions for any authenticated user who can view the branch:

- open the CR if it does not exist
- add top-level threads
- reply to threads

Owner-only actions:

- close CR
- reopen CR
- resolve threads
- reopen resolved threads

Optional later extension:

- admins/moderators may receive owner-equivalent operational powers

## Multi-Revision Support

### Patchsets

Each time a new revision lands on an open branch with an open CR, the CR gets a new patchset.

Patchset model:

```ts
{
  patchsetId: string;
  reviewId: string;
  ordinal: number;
  baseRevisionId: string;
  headRevisionId: string;
  baseSequenceNumber: number;
  headSequenceNumber: number;
  createdAt: Date;
  createdByUserId: string;
}
```

Rules:

- patchset `1` is created when the CR is first opened
- later commits create patchsets `2`, `3`, and so on
- the review page defaults to the latest patchset
- users may navigate older patchsets

### Threads

Threads attach to a patchset-specific score anchor.

Thread model:

```ts
{
  threadId: string;
  reviewId: string;
  patchsetId: string;
  workId: string;
  sourceId: string;
  branchName: string;
  anchor: {
    anchorId: string;
    partId?: string;
    measureStart?: number;
    measureEnd?: number;
    voiceId?: string;
    changeSide: "base" | "head" | "both";
    label: string;
  };
  status: "open" | "resolved" | "outdated";
  createdByUserId: string;
  resolvedAt?: Date;
  resolvedByUserId?: string;
  outdatedSincePatchsetId?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Rules:

- new threads start `open`
- owners resolve/reopen threads
- if a later patchset no longer contains the same anchor, mark the thread `outdated`
- outdated threads remain visible in history
- outdated does not imply resolved

Resolution remains explicit. New revisions can make a thread outdated, but should not silently auto-resolve it.

## Branch Lifecycle

### States

CR-enabled branches have explicit lifecycle:

- `open`
- `closed`

`open`:

- commits are allowed
- CR is open

`closed`:

- commits are rejected
- CR remains readable
- the only way to continue work is to reopen the CR

### Closing A CR

When the owner closes a CR:

- CR status becomes `closed`
- branch lifecycle becomes `closed`
- revision uploads to that branch are rejected

Recommended commit rejection:

```ts
{
  error: "branch_closed_for_review",
  branchName: "feature-a",
  reviewId: "cr_123"
}
```

This constraint is necessary. Without it, closing the CR has no operational meaning.

### Reopening A CR

When the owner reopens a CR:

- CR status becomes `open`
- branch lifecycle becomes `open`
- the next commit creates the next patchset on the same CR

Reopen must preserve the same CR record. Do not create a second CR for the same branch.

## Data Model

### ChangeReview

```ts
{
  reviewId: string;
  workId: string;
  sourceId: string;
  branchName: string;
  openedByUserId: string;
  ownerUserId: string;
  participantUserIds: string[];
  title?: string;
  summary?: string;
  status: "open" | "closed";
  branchLifecycle: "open" | "closed";
  latestPatchsetId: string;
  latestHeadRevisionId: string;
  latestHeadSequenceNumber: number;
  patchsetCount: number;
  unresolvedThreadCount: number;
  closedAt?: Date;
  closedByUserId?: string;
  reopenedAt?: Date;
  reopenedByUserId?: string;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes:

- unique: `{ workId: 1, sourceId: 1, branchName: 1 }`
- `{ openedByUserId: 1, lastActivityAt: -1 }`
- `{ ownerUserId: 1, status: 1, lastActivityAt: -1 }`

### ChangeReviewPatchset

```ts
{
  patchsetId: string;
  reviewId: string;
  workId: string;
  sourceId: string;
  branchName: string;
  ordinal: number;
  baseRevisionId: string;
  headRevisionId: string;
  baseSequenceNumber: number;
  headSequenceNumber: number;
  createdAt: Date;
  createdByUserId: string;
}
```

Indexes:

- `{ reviewId: 1, ordinal: -1 }`
- unique: `{ reviewId: 1, headRevisionId: 1 }`

### ChangeReviewComment

Keep the current comment record shape. It still works.

## Ownership And Participants

Owner resolution should persist on CR creation.

Recommended order:

1. declared branch owner for the branch, when present
2. branch head revision author, when a real user
3. source uploader

Participant rules:

- `openedByUserId` is informational, not exclusive
- `participantUserIds` should be dynamic
- users are added when they comment
- source uploader should always be included when distinct from owner

## API Design

### Create Or Open Branch CR

- `POST /api/works/:workId/sources/:sourceId/branches/:branchName/change-review`

Behavior:

- branch must be reviewable
- if CR exists, return it
- otherwise create CR and patchset `1` from current branch head

### Get Review Detail

- `GET /api/change-reviews/:reviewId`

Response should include:

- review metadata
- branch lifecycle
- latest patchset summary
- patchset list
- permission flags

### Get Patchset Diff

- `GET /api/change-reviews/:reviewId/patchsets/:patchsetId/diff`

This diff powers the visual score compare gutter.

### Add Thread

- `POST /api/change-reviews/:reviewId/threads`

Allowed for any authenticated branch viewer while CR is open.

### Reply To Thread

- `POST /api/change-reviews/:reviewId/threads/:threadId/comments`

Allowed for any authenticated branch viewer while CR is open.

### Resolve Or Reopen Thread

- `PATCH /api/change-reviews/:reviewId/threads/:threadId`

Owner-controlled in v1.

### Close Review

- `POST /api/change-reviews/:reviewId/close`

Owner only. Also closes the branch.

### Reopen Review

- `POST /api/change-reviews/:reviewId/reopen`

Owner only. Also reopens the branch.

### Commit Guard

Revision upload flow must validate branch lifecycle.

If the branch is closed for review:

- reject before Fossil write
- return `branch_closed_for_review`

### Patchset Creation Hook

When a new revision lands on a branch with an open CR:

- append a new patchset to that CR
- update `latestPatchsetId`
- update `latestHeadRevisionId`
- update `latestHeadSequenceNumber`

## Frontend Flow

### Works Page

For reviewable branches:

- show `Start CR` if branch has no CR
- show `Open CR` if branch already has one

For `owner_approval` branches:

- show no CR actions

### Score Editor

For reviewable branches:

- show `Open CR` in the revision list
- if CR exists, open it
- otherwise create/open the branch CR

For `owner_approval` branches:

- hide `Open CR`

### Review Page

The CR page is a branch review workspace.

It should show:

- branch name
- CR status
- branch lifecycle
- latest patchset
- patchset selector
- unresolved/resolved/outdated thread counts
- close/reopen controls

Primary closed-state message:

- `This review is closed. The branch is locked for new revisions until the review is reopened.`

## Notifications

Primary notification:

- `change_review_opened`

Recipients:

- all current CR participants
- all watchers of the source from the existing works-page watch system

Rules:

- recipient set is de-duplicated
- actor does not notify themselves
- watchers do not need to have commented previously
- source uploader should already be included through participant logic when applicable

Optional later notifications:

- `change_review_reopened`
- `change_review_new_patchset`

Do not notify on every comment in v1.

## Relationship To Existing Systems

### Revision Comments

Keep revision comments as general revision discussion.

Keep CR separate for:

- branch-scoped review
- score diff gutter comments
- patchset history
- branch close/reopen lifecycle

### Approvals

CR does not replace branch approval.

`owner_approval` branches are excluded from CR.
Public branches may use CR without changing the existing revision/approval model.

## Implementation Order

1. Replace revision-pair review schema with branch CR + patchsets.
2. Add branch review create/open endpoint.
3. Add explicit branch lifecycle for reviewable branches.
4. Add revision commit guard for closed branches.
5. Add patchset creation on branch-head updates.
6. Update review detail API/page to navigate patchsets.
7. Update score editor and works page to open CR by branch.
8. Remove CR entry points from `owner_approval` branches.
9. Add tests for shared commenting, branch closure, reopen, and patchset creation.

## Testing

### Backend

- cannot create CR on `owner_approval` branch
- creating CR on reviewable branch returns existing CR if present
- creating/opening CR creates patchset `1`
- committing to open CR branch creates a new patchset
- closing CR closes branch
- commit to closed branch returns `branch_closed_for_review`
- reopening CR reopens branch
- any authenticated branch viewer can create thread/reply
- only owner can close/reopen CR and resolve threads

### Frontend

- works page hides CR actions for `owner_approval` branches
- score editor hides `Open CR` for `owner_approval` branches
- score editor `Open CR` opens existing branch CR
- review page shows patchset selector
- closed review page shows branch-locked message

### Smoke

- user opens CR from score editor on a public branch
- second user comments on the same CR
- owner closes CR
- commit attempt on branch is rejected
- owner reopens CR
- new commit succeeds and creates a new patchset
