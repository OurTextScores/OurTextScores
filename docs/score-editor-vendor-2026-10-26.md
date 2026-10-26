# Score editor vendor refresh: 2026-10-26

The static editor under `frontend/public/score-editor/` is built from OTS_Web commit `701b06a4`.
It includes the Phase 9 audio-first page-turn correction, serialized score mutation ordering and the Phase 10
native grip commit/undo correction. The engine remains MuseScore 4.7.4.

Build: `npm run build:embed` in a clean detached OTS_Web worktree, with:

- `NEXT_PUBLIC_SOUNDFONT_CDN_URL=https://cdn.ourtextscores.com/soundfonts/default.sf3`
- `NEXT_PUBLIC_WEBMSCORE_RESOURCE_BASE_URL=https://cdn.ourtextscores.com/webmscore-resources/4.7.4/`
- Default continuous playback cursor and automatic follow feature gates.

WASM SHA-256: `1d3f4ba7f8a1ece17a26ac5767acc046d997e5bba549e8c3336e6bd3d43624b5`.
No soundfont is bundled. The obsolete standalone `webmscore.lib.js` is removed; production glue is bundled
into the static chunks. Copying used `rsync -a --delete --exclude soundfonts/`.

Before this refresh, the full 35-spec host smoke inventory passed on Chromium, Firefox and WebKit:
44 passed / 0 failed / 19 existing conditional skips per browser. These results are retained under
`.playwright-runs/phase10-{chromium,firefox,webkit}/`. The refreshed frontend Docker build passes. After recreating the local frontend, Chromium auth/public-links/SSE/player smoke checks pass 5/5 (16.3 seconds); the player URL/local-file flow also passes Firefox 1/1 (12 seconds) and WebKit 1/1 (9.7 seconds). The complete host matrix was not repeated after the bundle refresh. See OTS_Web `docs/engine/PHASE10_2026-10-26.md` for the editor matrix and limitations.

No push or production deployment is part of this refresh. Real Safari and mobile checks remain release follow-ups.
