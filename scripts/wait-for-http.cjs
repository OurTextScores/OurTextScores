#!/usr/bin/env node

const target = process.argv[2];
const timeoutMs = Number(process.argv[3] || 120_000);

if (!target) {
  console.error("Usage: node scripts/wait-for-http.cjs <url> [timeout-ms]");
  process.exit(2);
}

async function waitForHttp() {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        console.log(`Ready: ${target}`);
        return;
      }
      await response.body?.cancel();
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timeout waiting for ${target}`);
}

waitForHttp().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
