#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const composePrefix = [
  "compose",
  "--profile",
  "scanner",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.scanner-smoke.yml",
  "-f",
  "docker-compose.scanner-service-recovery-smoke.yml",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function compose(args) {
  run("docker", [...composePrefix, ...args]);
}

let failed = false;
try {
  compose(["down", "-v", "--remove-orphans"]);
  compose(["build", "backend", "frontend", "scanner_worker"]);
  compose(["up", "-d"]);
  run("node", ["smoke/utils/wait.cjs"]);
  run(
    "npx",
    [
      "playwright",
      "test",
      "-c",
      "smoke/playwright.config.cjs",
      "--project=chromium",
      "scanner-service-recovery.spec.cjs",
    ],
    { env: { SCANNER_SERVICE_RECOVERY: "1" } },
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  try {
    compose(["down", "-v", "--remove-orphans"]);
  } catch (error) {
    failed = true;
    console.error(
      `Scanner service recovery teardown failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failed) process.exitCode = 1;
