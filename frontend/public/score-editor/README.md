# Score Editor (Embedded Build)

This directory contains the static build of the OTS Score Editor, embedded from the [OTS_Web](https://github.com/OurTextScores/OTS_Web) project.

## Audio Playback

Audio playback uses a soundfont loaded from **Cloudflare R2 CDN**:
- **URL**: `https://cdn.ourtextscores.com/default.sf2` (142MB)
- **Why**: Soundfont exceeds GitHub's 100MB file size limit
- **Result**: ✅ Audio works in production and local development

No local soundfont files needed - everything loads from CDN.

## Updating the Score Editor

To update with the latest version from OTS_Web:

```bash
# In OTS_Web repository
cd ~/workspace/OTS_Web
npm run build:embed

# Copy to OurTextScores
cd ~/workspace/OurTextScores
rm -rf frontend/public/score-editor/*
cp -r ~/workspace/OTS_Web/out/* frontend/public/score-editor/

# Rebuild Docker (if using)
docker compose build --no-cache frontend
docker compose up -d frontend
```

## Features

- ✅ Full score editing with MusicXML support
- ✅ Audio playback via CDN soundfont
- ✅ AI assistant (requires OpenAI API key)
- ✅ Export to PDF, MIDI, PNG, etc.
- ✅ All features work in embedded/static mode
