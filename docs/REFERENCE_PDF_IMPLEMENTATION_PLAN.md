# Reference PDF Feature Implementation Plan

## Overview

Add functionality to upload optional "reference PDF" files alongside score uploads, display them side-by-side with generated PDFs, and enable filtering works by reference PDF availability.

## Requirements

1. **Upload**: Add optional reference PDF file input to upload forms
2. **Storage**: Store reference PDFs in MinIO alongside other derivatives
3. **Display**: Side-by-side PDF viewers (reference left, generated right)
4. **Database**: Mark sources with `hasReferencePdf` boolean flag
5. **Search**: Filter works by reference PDF availability on main page

## Architecture Changes

### Database Schema

**Add to `DerivativeArtifacts` schema** (`backend/src/works/schemas/derivatives.schema.ts`):
```typescript
@Prop({ type: StorageLocatorSchema })
referencePdf?: StorageLocator;
```

**Add to `Source` schema** (`backend/src/works/schemas/source.schema.ts`):
```typescript
@Prop({ required: true, default: false })
hasReferencePdf!: boolean;
```

**Add to search index** (`backend/src/search/search.service.ts`):
- Add `hasReferencePdf?: boolean` to `WorkSearchDocument` interface
- Add `'hasReferencePdf'` to `filterableAttributes` array

**No migration needed** - optional fields with defaults are backward compatible.

### Backend API Changes

**File Upload** (`backend/src/works/works.controller.ts`):
- Replace `FileInterceptor('file')` with `FileFieldsInterceptor([{name:'file', maxCount:1}, {name:'referencePdf', maxCount:1}])`
- Update both upload endpoints (new source + revision)
- Validate reference PDF: type=`application/pdf`, max size=50MB

**Upload Service** (`backend/src/works/upload-source.service.ts`):
- Check for `request.referencePdfFile` in both `upload()` and `uploadRevision()` methods
- If present:
  - Store using `storageService.putAuxiliaryObject()` at path `{workId}/{sourceId}/rev-{seq}/reference.pdf`
  - Create `StorageLocator` with SHA256 checksum
  - Add to `derivatives.referencePdf`
  - Set `hasReferencePdf: true` on source document
  - Emit progress event: `'store.refpdf'`

**Download Endpoint** (`backend/src/works/works.controller.ts`):
```typescript
@Get(":workId/sources/:sourceId/reference.pdf")
async downloadReferencePdf(
  @Param('workId') workId: string,
  @Param('sourceId') sourceId: string,
  @Query('r') revisionId?: string,
  @Res() res: Response
)
```
- Mirrors existing `downloadPdf()` and `downloadMscz()` endpoints
- Supports revision-specific downloads via `?r=revisionId` query param
- Returns 404 if reference PDF not found

**Search Filter** (`backend/src/works/works.controller.ts`):
- Add `@Query('filter')` parameter to `listWorks()` endpoint
- Pass filter to `worksService.listWorks()` and MeiliSearch

### Frontend Changes

**TypeScript Interfaces** (`frontend/app/lib/api.ts`):
```typescript
export interface DerivativeArtifacts {
  // ... existing fields
  referencePdf?: StorageLocator;
}
```

**Upload Forms** (`frontend/app/works/[workId]/upload-new-source-form.tsx` + `upload-revision-form.tsx`):
- Add state: `const [referencePdfFile, setReferencePdfFile] = useState<File | null>(null)`
- Add file input after main file input:
  ```tsx
  <input
    type="file"
    accept=".pdf,application/pdf"
    onChange={(e) => setReferencePdfFile(e.target.files?.[0] ?? null)}
  />
  ```
- Append to FormData: `form.append("referencePdf", referencePdfFile)`

**Dual PDF Viewer Component** - NEW FILE (`frontend/app/works/[workId]/dual-pdf-viewer.tsx`):
- Props: `workId`, `sourceId`, `revisionId`, `hasReferencePdf`
- Load both PDFs via fetch, create blob URLs
- If `hasReferencePdf=false`: render single viewer (backward compatible)
- If `hasReferencePdf=true`: render grid with two columns:
  - Left: "Reference PDF (Uploaded)"
  - Right: "Generated PDF (From Score)"
- Handle loading/error states independently
- Cleanup blob URLs on unmount
- Use `grid-cols-2` for side-by-side layout

**Source Card Integration** (`frontend/app/works/[workId]/source-card.tsx`):
- Replace `<PdfViewer>` with `<DualPdfViewer>` component
- Pass `hasReferencePdf={source.hasReferencePdf ?? false}` prop
- Update "Score preview (PDF)" summary to show "(with reference)" badge if applicable
- Add `StorageBadge` for reference PDF download

**Search Page Filter** (`frontend/app/page.tsx`):
- Add state: `const [filterReferencePdf, setFilterReferencePdf] = useState(false)`
- Add checkbox UI:
  ```tsx
  <label>
    <input
      type="checkbox"
      checked={filterReferencePdf}
      onChange={(e) => setFilterReferencePdf(e.target.checked)}
    />
    Has reference PDF
  </label>
  ```
- Pass filter to API: `filter: filterReferencePdf ? 'hasReferencePdf = true' : undefined`
- Update both `searchWorks()` and `fetchWorksPaginated()` calls

## Implementation Steps

### Phase 1: Backend Foundation (3-4 hours)
1. Update `derivatives.schema.ts` - add `referencePdf` field
2. Update `source.schema.ts` - add `hasReferencePdf` flag
3. Update `search.service.ts` - add to search index
4. Update upload endpoints to accept two files (`FileFieldsInterceptor`)
5. Modify `upload-source.service.ts`:
   - Store reference PDF in both `upload()` and `uploadRevision()` methods
   - Set `hasReferencePdf` flag
6. Add `downloadReferencePdf()` endpoint to controller
7. Add backend unit tests

### Phase 2: Frontend UI (4-5 hours)
8. Update `api.ts` TypeScript interfaces
9. Create `dual-pdf-viewer.tsx` component
10. Update both upload forms to add reference PDF input
11. Integrate dual viewer in `source-card.tsx`
12. Add reference PDF badge to source card
13. Add frontend component tests

### Phase 3: Search & Polish (2-3 hours)
14. Update backend search to accept filter parameter
15. Add checkbox filter to search page frontend
16. Add E2E integration tests
17. Manual testing checklist
18. Update documentation (AGENTS.md)

## Critical Files to Modify

**Backend (5 files):**
1. `backend/src/works/schemas/derivatives.schema.ts` - Add referencePdf field
2. `backend/src/works/schemas/source.schema.ts` - Add hasReferencePdf flag
3. `backend/src/works/upload-source.service.ts` - Store reference PDF logic
4. `backend/src/works/works.controller.ts` - Upload/download endpoints
5. `backend/src/search/search.service.ts` - Search index config

**Frontend (6 files + 1 new):**
6. `frontend/app/lib/api.ts` - TypeScript interfaces
7. `frontend/app/works/[workId]/upload-new-source-form.tsx` - Add PDF input
8. `frontend/app/works/[workId]/upload-revision-form.tsx` - Add PDF input
9. `frontend/app/works/[workId]/dual-pdf-viewer.tsx` - **NEW FILE** - Side-by-side viewer
10. `frontend/app/works/[workId]/source-card.tsx` - Integrate dual viewer
11. `frontend/app/page.tsx` - Add search filter
12. `frontend/app/works/[workId]/revision-history.tsx` - Add reference PDF badge (optional)

## Testing Strategy

**Unit Tests:**
- Schema validation for `referencePdf` field
- Upload service handles reference PDF correctly
- Download endpoint returns PDF with correct headers
- Dual viewer renders correctly for both modes

**Integration Tests (E2E):**
- Upload score + reference PDF → both stored and downloadable
- Upload without reference PDF → single viewer fallback
- Search filter includes/excludes works correctly
- Revision-specific downloads work

**Manual Testing:**
- [ ] Upload new source with reference PDF
- [ ] Upload new source without reference PDF
- [ ] Upload revision with reference PDF
- [ ] Download reference PDF (latest + specific revision)
- [ ] Verify dual viewer side-by-side layout
- [ ] Verify single viewer fallback
- [ ] Test search filter checkbox
- [ ] Test responsive layout on mobile
- [ ] Test in different browsers (Chrome, Firefox, Safari)

## Verification Steps

After implementation:

1. **Backend verification:**
   ```bash
   cd backend
   npm test  # Run unit tests
   npm run build  # Verify TypeScript compiles
   ```

2. **Upload test:**
   - Navigate to work page
   - Click "Upload new source"
   - Select .mscz file + reference PDF
   - Submit and verify progress events
   - Check derivatives in database: `referencePdf` should exist

3. **Display test:**
   - View source with reference PDF
   - Expand "Score preview (PDF)" section
   - Verify two PDFs side-by-side with headers
   - Check single viewer for sources without reference

4. **Search test:**
   - Go to main page
   - Enable "Has reference PDF" checkbox
   - Verify filtered results only show works with reference PDFs
   - Disable checkbox and verify all works appear

5. **E2E tests:**
   ```bash
   cd smoke
   npm run test  # Run Playwright tests
   ```

## Edge Cases Handled

1. **Reference PDF on rev 1, none on rev 2**: Each revision has independent `derivatives.referencePdf`
2. **Reference exists but generated fails**: Show reference only + error message
3. **Browser doesn't support PDF**: Fallback to download link (existing behavior)
4. **Large PDFs**: 50MB size limit, same as score files
5. **Non-PDF uploaded as reference**: Client + server validation reject non-PDFs

## Risk Assessment

**Low Risk:**
- All changes are additive (no breaking changes)
- Optional fields with sensible defaults
- Backward compatible with existing data
- Follows existing MSCZ artifact pattern exactly

## Notes

- Pattern follows existing MSCZ artifact implementation closely
- MongoDB handles optional field addition automatically (no migration)
- Storage path: `{workId}/{sourceId}/rev-{seq}/reference.pdf`
- Download URL: `/works/:workId/sources/:sourceId/reference.pdf?r=revisionId`
- Dual viewer is responsive: side-by-side on desktop, could stack on mobile
