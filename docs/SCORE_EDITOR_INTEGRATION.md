# Score Editor Integration

This document describes the integration between OurTextScores and the OTS_Web Score Editor for opening and comparing musical scores.

## Overview

OurTextScores now integrates with the OTS_Web Score Editor to provide two key features:

1. **Open Score in Editor**: Opens a score in the full OTS_Web editor for viewing and editing
2. **Visual Diff (Score Editor)**: Embeds the OTS_Web editor to show side-by-side comparison of two score revisions

## Configuration

### Environment Variable

Add the following environment variable to your `.env` file:

```env
NEXT_PUBLIC_SCORE_EDITOR_URL=http://localhost:3000/score-editor
```

**For production**, set this to the URL where your OTS_Web editor is deployed (e.g., `https://editor.yourdomain.com`).

### Running OTS_Web Locally

For local development, you can run the OTS_Web editor at the same origin:

**Option 1: Serve the OTS_Web build from OurTextScores (Recommended)**
1. Build OTS_Web for static export:
   ```bash
   cd ~/workspace/OTS_Web
   npm run build:embed
   ```

2. Copy the `out/` directory to OurTextScores frontend public directory:
   ```bash
   cp -r out ../OurTextScores/frontend/public/score-editor
   ```

3. The editor will be available at `http://localhost:3000/score-editor`

**Option 2: Run OTS_Web on a separate port**
1. Navigate to the OTS_Web directory:
   ```bash
   cd ~/workspace/OTS_Web
   ```

2. Start the dev server on port 3001:
   ```bash
   PORT=3001 npm run dev
   ```

3. Update `.env` to use `http://localhost:3001`

**Note**: OurTextScores runs on port 3000 by default.

## Features

### 1. Open Score in Editor Button

**Location**: Works detail page, next to "Download MXL" button

**What it does**:
- Opens the score's canonical XML in a new tab in the OTS_Web editor
- Allows users to view, edit, and interact with the score using the full editor interface

**URL format**:
```
{SCORE_EDITOR_URL}/?score={canonicalXmlUrl}
```

**Example**:
```
http://localhost:3001/?score=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fworks%2F123%2Fsources%2Fabc%2Fcanonical.xml
```

### 2. Visual Diff (Score Editor)

**Location**: Diff Preview component in the revision history section

**What it does**:
- Embeds the OTS_Web editor in an iframe showing side-by-side comparison of two revisions
- Uses the OTS_Web embed mode feature (see `OTS_Web/EMBED_MODE_IMPLEMENTATION.md`)
- Displays revision sequence numbers as labels (e.g., "Rev #1" vs "Rev #2")

**URL format**:
```
{SCORE_EDITOR_URL}/?compareLeft={leftXmlUrl}&compareRight={rightXmlUrl}&leftLabel={leftLabel}&rightLabel={rightLabel}
```

**Example**:
```
http://localhost:3001/?compareLeft=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fworks%2F123%2Fsources%2Fabc%2Fcanonical.xml%3Fr%3Drev1&compareRight=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fworks%2F123%2Fsources%2Fabc%2Fcanonical.xml%3Fr%3Drev2&leftLabel=Rev%20%231&rightLabel=Rev%20%232
```

**UI Changes**:
- The dropdown option is labeled "Visual Diff (Score Editor)"
- The "Open visual PDF" button is now "Open in Score Editor"
- Removed redundant "Diff (visual)" and "Diff (visual PDF)" badges from the source card
- Kept the "Diff (text)" badge for canonical/manifest text diffs

## Implementation Details

### Files Modified

1. **`.env`**
   - Added `NEXT_PUBLIC_SCORE_EDITOR_URL` environment variable
   - Set to `http://localhost:3000/score-editor` for local development

2. **`frontend/app/works/[workId]/source-card.tsx`**
   - Added "Open Score in Editor" button next to "Download MXL"
   - Implemented absolute URL conversion for API links (detects relative URLs and converts to absolute)
   - Removed "Diff (visual)" and "Diff (visual PDF)" badges (replaced with DiffPreview integration)
   - Renamed "Diff" badge to "Diff (text)" for clarity

3. **`frontend/app/works/[workId]/diff-preview.tsx`**
   - Added `SCORE_EDITOR_URL` constant from environment variable
   - Added logic to find revision sequence numbers for labels
   - Implemented absolute URL conversion for API links
   - Replaced PDF embed with iframe embed of OTS_Web editor for visual diff
   - Updated dropdown label to "Visual Diff (Score Editor)"
   - Updated "Open visual PDF" button to "Open in Score Editor"

### Absolute URL Conversion

Both components now include logic to ensure API URLs are absolute when passed to the external editor:

```typescript
const absoluteApiBase = PUBLIC_API_BASE.startsWith('http')
  ? PUBLIC_API_BASE
  : `${window.location.protocol}//${window.location.hostname}:4000${PUBLIC_API_BASE}`;
```

This handles cases where `PUBLIC_API_BASE` is:
- Relative: `/api` → `http://localhost:4000/api`
- Already absolute: `http://localhost:4000/api` → unchanged

This is necessary because OTS_Web runs on a different origin and needs absolute URLs to fetch the XML files from the OurTextScores API.

### CORS Considerations

For the embed to work correctly, the OTS_Web editor must be accessible from the browser and must have proper CORS headers if hosted on a different domain.

**For local development**: Both apps run on localhost, so CORS is not an issue.

**For production**: Ensure the OTS_Web editor is configured to allow embedding from the OurTextScores domain.

## Testing

### Manual Testing Checklist

1. **Open Score in Editor**:
   - [ ] Navigate to a work detail page with uploaded sources
   - [ ] Click "Open Score in Editor" button next to "Download MXL"
   - [ ] Verify score opens in new tab in OTS_Web editor
   - [ ] Verify score loads and displays correctly

2. **Visual Diff**:
   - [ ] Navigate to a source with multiple revisions
   - [ ] Open the "Revision history" section
   - [ ] Select two different revisions from the dropdowns
   - [ ] Select "Visual Diff (Score Editor)" from the Type dropdown
   - [ ] Verify the iframe loads and displays side-by-side comparison
   - [ ] Verify labels show correct revision numbers
   - [ ] Click "Open in Score Editor" button
   - [ ] Verify comparison opens in new tab

### Troubleshooting

**Problem**: "Open Score in Editor" button doesn't appear
- **Solution**: Ensure the source has `derivatives.normalizedMxl` available

**Problem**: Editor shows "No score loaded" message
- **Solution**: This was caused by passing relative URLs (`/api/works/...`) to the editor instead of absolute URLs
- **Fix applied**: The code now automatically converts relative API URLs to absolute URLs by detecting if `PUBLIC_API_BASE` starts with `http` and prepending the protocol/hostname/port if needed
- **Example**: `/api/works/123/sources/abc/canonical.xml` → `http://localhost:4000/api/works/123/sources/abc/canonical.xml`

**Problem**: Visual diff iframe shows blank or error
- **Solution**:
  - Check that OTS_Web is running on the configured port
  - Verify `NEXT_PUBLIC_SCORE_EDITOR_URL` is set correctly
  - Check browser console for CORS or network errors
  - Ensure canonical XML files are accessible
  - Verify the API backend is accessible from the browser

**Problem**: CORS errors in browser console
- **Solution**:
  - For local dev: Ensure both apps run on localhost (different ports OK)
  - For production: Configure CORS headers on the backend API to allow requests from the OTS_Web domain
  - The backend API must be publicly accessible (not just via Docker internal network)

## Future Enhancements

- [ ] Add loading indicator while iframe is loading
- [ ] Add error handling for failed iframe loads
- [ ] Consider pre-loading the editor in background for faster response
- [ ] Add option to configure iframe height via user preferences
- [ ] Support additional query parameters (e.g., initial zoom level)

## References

- [OTS_Web EMBED_MODE_IMPLEMENTATION.md](../../OTS_Web/EMBED_MODE_IMPLEMENTATION.md) - Details on the embed mode feature
- [OTS_Web AGENTS.md](../../OTS_Web/AGENTS.md) - Overview of the OTS_Web score editor
