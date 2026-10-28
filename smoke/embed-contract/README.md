# Vendored editor contract check

Run `npm run smoke:embed-contract` after installing root and frontend dependencies and
Playwright Chromium (`npm run smoke:install`). It requires `rsync` and a built editor
under `frontend/public/score-editor/`. The check makes a temporary copy of the frontend,
mounts the real scanner and review components in a test-only route, and starts a local
Next.js server on an ephemeral loopback port. It uses fixture API responses; it does not
exercise the backend or modify Docker services or persistent data.

The browser opens multiple real vendored editor frames and checks finding, height and
review message isolation, reading replacement and comparison rendering. Set
`EMBED_CONTRACT_SCREENSHOT` to save a screenshot on failure. Temporary files and the
server are removed when the check finishes.

The `Vendored editor contract` GitHub Actions workflow runs the Chromium check on
pull requests and pushes to `main` when frontend, vendored editor, test, or root
dependency files change. It also supports manual dispatch. CI checks the editor
committed in this repository; editor changes need to be vendored before they are
covered here.
