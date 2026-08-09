#!/usr/bin/env node
//
// Pre-flight for the Modal HOMR provider. Checks credentials, readiness, and
// provenance before any OTS container is started, and prints the model-pin
// export lines for runbook step 5.
//
//   npm run scanner:modal:check
//
// Reads SCANNER_PROVIDER_URL, SCANNER_MODAL_TOKEN_ID, SCANNER_MODAL_TOKEN_SECRET
// from the environment or .env. Sends exactly the headers the scanner worker
// sends, so a pass here means the worker will authenticate too.

const { readFileSync } = require("node:fs");

function loadDotEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is fine; the environment may carry everything.
  }
}

loadDotEnv();

const url = (process.env.SCANNER_PROVIDER_URL || "").trim().replace(/\/$/, "");
const tokenId = (process.env.SCANNER_MODAL_TOKEN_ID || "").trim();
const tokenSecret = (process.env.SCANNER_MODAL_TOKEN_SECRET || "").trim();
const expectedCommit = (
  process.env.SCANNER_EXPECTED_HOMR_COMMIT ||
  "1ddc6fcc26c4baa746eaffbba7f5e01429063465"
).trim();
const expectedRevision = (
  process.env.SCANNER_EXPECTED_PROVIDER_REVISION || "ots-homr-modal-v1"
).trim();
const expectedExecutionProvider = (
  process.env.SCANNER_EXPECTED_EXECUTION_PROVIDER || "CUDAExecutionProvider"
).trim();
const readyTimeoutMs = Number(process.env.SCANNER_MODAL_READY_TIMEOUT_MS || 300_000);

if (!url || !tokenId || !tokenSecret) {
  console.error(
    "Missing configuration. Set SCANNER_PROVIDER_URL, SCANNER_MODAL_TOKEN_ID,\n" +
      "and SCANNER_MODAL_TOKEN_SECRET in .env or the environment.",
  );
  process.exit(2);
}

// Exactly what ScannerProviderService sends.
const headers = {
  Authorization: `Bearer ${tokenId}.${tokenSecret}`,
  "Modal-Key": tokenId,
  "Modal-Secret": tokenSecret,
  Accept: "application/json",
};

const problems = [];
const ok = (message) => console.log(`  ok    ${message}`);
const bad = (message) => {
  console.log(`  FAIL  ${message}`);
  problems.push(message);
};

async function get(path) {
  const response = await fetch(`${url}${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function main() {
  console.log(`Modal provider: ${url}\n`);

  console.log("Authentication and liveness");
  let health;
  try {
    health = await get("/healthz");
  } catch (error) {
    bad(`could not reach the provider: ${error.message}`);
    return;
  }
  if (health.status === 401 || health.status === 403) {
    bad(`proxy authentication rejected (HTTP ${health.status}) — check the token`);
    return;
  }
  if (health.status !== 200) {
    bad(`/healthz returned HTTP ${health.status}`);
    return;
  }
  ok("proxy token accepted, HTTP process alive");

  console.log("\nReadiness (models loaded and warm-up inference completed)");
  const startedAt = Date.now();
  let ready;
  for (;;) {
    ready = await get("/readyz");
    if (ready.status === 200) break;
    if (Date.now() - startedAt > readyTimeoutMs) break;
    const note = `  ...waiting ${Math.round((Date.now() - startedAt) / 1000)}s (${
      ready.body?.reason || "warming up"
    })`;
    // Redraw in place on a terminal; keep one line per poll in a log.
    process.stdout.isTTY ? process.stdout.write(`${note}\r`) : console.log(note);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (process.stdout.isTTY) process.stdout.write("".padEnd(100) + "\r");
  if (ready.status !== 200) {
    bad(`not ready after ${Math.round((Date.now() - startedAt) / 1000)}s: ${ready.body?.reason}`);
    // The usual cause of a CUDA-unavailable readiness failure is the CPU
    // onnxruntime distribution shadowing onnxruntime-gpu, so show what the
    // runtime can actually see rather than making that a separate dig.
    const available = ready.body?.availableExecutionProviders;
    if (Array.isArray(available)) {
      console.log(`        ONNX Runtime sees: ${available.join(", ") || "(none)"}`);
      console.log(`        it needs:          ${expectedExecutionProvider}`);
    }
  } else {
    ok(`ready after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    if (ready.body?.degradedReason) {
      bad(`degraded: ${ready.body.degradedReason}`);
    }
  }

  console.log("\nProvenance (must match what OTS will require, or it fails closed)");
  const caps = await get("/v1/capabilities");
  if (caps.status !== 200) {
    bad(`/v1/capabilities returned HTTP ${caps.status}`);
    return;
  }
  const body = caps.body || {};
  const check = (label, actual, expected) =>
    actual === expected
      ? ok(`${label}: ${actual}`)
      : bad(`${label}: provider says "${actual}", OTS expects "${expected}"`);

  check("HOMR commit", body.homrRevision, expectedCommit);
  check("service revision", body.serviceRevision, expectedRevision);
  check("execution provider", body.executionProvider, expectedExecutionProvider);

  console.log("\nLicence disclosure (AGPL section 13)");
  body.providerLicense && body.homrLicense && body.source
    ? ok(`${body.providerLicense} / ${body.homrLicense} — ${body.source}`)
    : bad("/v1/capabilities is missing source or licence fields");

  console.log("\nModel weights actually loaded");
  const models = {
    SEGMENTATION: body.segmentationModelSha256,
    ENCODER: body.encoderModelSha256,
    DECODER: body.decoderModelSha256,
  };
  for (const [name, sha] of Object.entries(models)) {
    sha ? ok(`${name.toLowerCase()}: ${sha}`) : bad(`${name.toLowerCase()} hash missing`);
  }
  if (Object.values(models).every(Boolean)) {
    console.log(
      "\nPin them, then redeploy so a changed weight file fails readiness:\n",
    );
    for (const [name, sha] of Object.entries(models)) {
      console.log(`  export HOMR_EXPECTED_${name}_SHA256=${sha}`);
    }
    console.log("  modal deploy modal_app.py");
  }
}

function report() {
  console.log("");
  if (problems.length === 0) {
    console.log("All checks passed. Safe to run: npm run scanner:modal:up");
    return;
  }
  console.log(`${problems.length} problem(s) found; do not start the stack yet.`);
  process.exitCode = 1;
}

main()
  .catch((error) => {
    bad(`unexpected failure: ${error.message}`);
  })
  // Always report, including from main()'s early returns — a check that prints
  // FAIL but exits 0 is worse than no check at all.
  .finally(report);
