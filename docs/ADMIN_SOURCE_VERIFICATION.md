# Admin Source Verification System

**Status**: In Progress
**Date**: 2026-01-26

## Overview

Admins can verify sources as valid transcriptions and flag sources for deletion. This helps curate quality content and signals trustworthiness to users.

## Source Schema Changes

Add verification and flagging fields to the `Source` schema:

```typescript
{
  // Verification (source is a valid transcription)
  adminVerified?: boolean;
  adminVerifiedBy?: string;        // userId of admin
  adminVerifiedAt?: Date;
  adminVerificationNote?: string;  // optional note

  // Flagging (source should be deleted)
  adminFlagged?: boolean;
  adminFlaggedBy?: string;
  adminFlaggedAt?: Date;
  adminFlagReason?: string;        // why it was flagged
}
```

## Work Schema Changes

For filtering on the main page:

```typescript
{
  hasVerifiedSources?: boolean;  // aggregated: any source has adminVerified=true
}
```

## API Endpoints

```typescript
// Verify a source as valid
POST /api/works/:workId/sources/:sourceId/verify
Headers: Authorization (admin required)
Body: { note?: string }
Response: { ok: true, verifiedAt: Date }

// Remove verification
DELETE /api/works/:workId/sources/:sourceId/verify
Headers: Authorization (admin required)
Response: { ok: true }

// Flag source for deletion
POST /api/works/:workId/sources/:sourceId/flag
Headers: Authorization (admin required)
Body: { reason: string }
Response: { ok: true, flaggedAt: Date }

// Remove flag
DELETE /api/works/:workId/sources/:sourceId/flag
Headers: Authorization (admin required)
Response: { ok: true }
```

## Authorization

All endpoints require admin role:

```typescript
const isAdmin = currentUser?.roles?.includes('admin');
```

## Frontend UI

### Source Card (Work Detail Page)

**Status Badges:**
- ✅ **Admin Verified** (green badge) - hover shows admin name, date, and note
- ⚠️ **Flagged for Deletion** (red badge) - hover shows reason and admin name

**Admin Action Panel** (visible only to admins):
```
[Admin Actions] ▼
  • Verify Source
  • Flag for Deletion
  • Remove Verification (if verified)
  • Remove Flag (if flagged)
  • Delete Source (existing)
```

### Main Page Filter

Add checkbox next to "Has reference PDF":
- ☑️ **Admin Verified** - filters to works with at least one verified source

## Business Rules

1. **Verification:**
   - Binary flag (true/false) applied to the source as a whole
   - Optional note for context
   - Reversible (admin can remove verification)
   - Independent of revisions (applies to the source)

2. **Flagging:**
   - Marks source as problematic
   - Requires reason text
   - Source remains visible but marked with warning
   - Reversible
   - Serves as reminder for admin to review and potentially delete

3. **Mutual States:**
   - A source can be both verified AND flagged (e.g., was good, now has bad revisions)
   - UI shows both states clearly

4. **Work Stats:**
   - `hasVerifiedSources` computed from source-level flags
   - Recomputed when source verification changes
   - Indexed in MeiliSearch for filtering

## Search/MeiliSearch Integration

Update search configuration:

```typescript
filterableAttributes: [
  // ... existing
  'hasVerifiedSources'
],
displayedAttributes: [
  // ... existing
  'hasVerifiedSources'
]
```

## Work Stats Recomputation

Update `recomputeWorkStats()`:

```typescript
const hasVerifiedSources = sources.some(s => s.adminVerified === true);
const hasReferencePdf = sources.some(s => s.hasReferencePdf === true);

await this.workModel.findOneAndUpdate(
  { workId },
  { $set: { sourceCount, availableFormats, hasReferencePdf, hasVerifiedSources } }
);
```

## Implementation Phases

### Phase 1: Backend Core
- [x] Update Source schema
- [ ] Update Work schema
- [ ] Create verification endpoints
- [ ] Create flagging endpoints
- [ ] Update work stats recomputation
- [ ] Update MeiliSearch configuration

### Phase 2: Frontend UI
- [ ] Add admin action panel to source cards
- [ ] Add verification badge
- [ ] Add flagging badge
- [ ] Add filter checkbox on main page
- [ ] Update TypeScript interfaces

### Phase 3: Testing
- [ ] Write unit tests for endpoints
- [ ] Write E2E test for verification flow
- [ ] Write E2E test for flagging flow
- [ ] Test filter functionality

## Future Enhancements

When the site has trusted community members:
- Add "moderator" role with same permissions
- Simple change: `isAdmin || isModerator` in auth checks
- Consider separate moderation dashboard
- Activity log for moderation actions
