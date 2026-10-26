// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Load the repo `.env` into the test process. Several specs mint their own JWT
// with `process.env.NEXTAUTH_SECRET || 'dev-secret'`; without this they signed
// tokens with `dev-secret` while the stack ran a real secret, so every such
// request 401'd and the failures surfaced far from the cause. Anything already
// set in the environment wins, so CI and one-off overrides still apply.
function loadRepoEnv() {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue
        .replace(/\s+#.*$/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env is fine; specs fall back to their own defaults.
  }
}

loadRepoEnv();

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120 * 1000, // Increased to 120 seconds for complex tests with file uploads
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    // Cross-browser runs (Phase 10 of the OTS_Web playback plan). The existing npm scripts pass --project=chromium.
    // On Ubuntu 26.04 hosts, run with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64.
    {
      name: 'firefox',
      // PLAYWRIGHT_FIREFOX_EXECUTABLE=/path/to/firefox drives stock Firefox over WebDriver BiDi. Playwright's own Firefox
      // build has no optimizing WebAssembly compiler, so the embedded editor runs 5-10x slower there than for users.
      use: {
        ...devices['Desktop Firefox'],
        ...(process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE
          ? { channel: 'moz-firefox', launchOptions: { executablePath: process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE } }
          : {})
      }
    },
    {
      name: 'webkit',
      // WebKit (WPE) hangs on its first page without a GPU render device; software GL works.
      use: { ...devices['Desktop Safari'], launchOptions: { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' } } }
    }
  ]
});
