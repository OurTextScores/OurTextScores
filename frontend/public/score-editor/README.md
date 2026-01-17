# Score Editor (Embedded Build)

This directory contains the static build of the OTS Score Editor, embedded from the [OTS_Web](https://github.com/OurTextScores/OTS_Web) project.

## Important: Soundfont Files

**Soundfont files (142MB) are excluded from git** due to GitHub's 100MB file size limit. This affects:
- ✅ All other features work normally
- ❌ Audio playback will not work without a soundfont

### For Production (Vercel) - Audio Playback Currently Unavailable

The soundfont is NOT included in Vercel deployments. See [docs/SOUNDFONT_SETUP.md](../../docs/SOUNDFONT_SETUP.md) for options to enable audio:
- Upload soundfont to Cloudflare R2
- Add build script to download during deployment
- Or keep audio playback disabled

### For Local Development (Docker)

To add soundfonts for local testing:

```bash
# Copy from OTS_Web build
mkdir -p frontend/public/score-editor/soundfonts
cp ~/soundfonts.backup/default.sf2 frontend/public/score-editor/soundfonts/

# Rebuild Docker
docker compose build --no-cache frontend
docker compose up -d frontend
```

## Updating the Score Editor

To update with the latest version from OTS_Web:

```bash
# In OTS_Web repository
cd ~/workspace/OTS_Web
npm run build:embed:full

# Copy to OurTextScores (excluding soundfonts)
cd ~/workspace/OurTextScores
rm -rf frontend/public/score-editor/*
cp -r ~/workspace/OTS_Web/out/* frontend/public/score-editor/
rm -rf frontend/public/score-editor/soundfonts  # Excluded from git

# For local development, optionally copy soundfonts:
mkdir -p frontend/public/score-editor/soundfonts
cp ~/soundfonts.backup/default.sf2 frontend/public/score-editor/soundfonts/

# Rebuild Docker (if using)
docker compose build --no-cache frontend
docker compose up -d frontend
```

## Features

- ✅ Full score editing with MusicXML support
- ✅ AI assistant (requires OpenAI API key)
- ✅ Export to PDF, MIDI, PNG, etc.
- ✅ All features work in embedded/static mode
- ⚠️ Audio playback requires soundfont (see above)
