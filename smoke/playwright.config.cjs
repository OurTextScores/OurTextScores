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
    }
  ]
});
