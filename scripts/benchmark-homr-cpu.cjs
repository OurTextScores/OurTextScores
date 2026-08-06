#!/usr/bin/env node

const { execFile, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename, extname, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const inputPath = process.argv[2] ? resolve(process.argv[2]) : "";
if (
  !inputPath ||
  ![".png", ".jpg", ".jpeg"].includes(extname(inputPath).toLowerCase())
) {
  console.error(
    "Usage: npm run scanner:local:benchmark -- /absolute/path/to/page.png",
  );
  process.exit(2);
}

const endpoint = (
  process.env.HOMR_LOCAL_URL || "http://127.0.0.1:8010"
).replace(/\/$/, "");
const token = process.env.HOMR_LOCAL_PROVIDER_TOKEN || "ots-local-development";
const container = process.env.HOMR_LOCAL_CONTAINER || "ourtextscores_homr_cpu";
const shouldRestart = process.env.HOMR_BENCHMARK_RESTART !== "0";
const input = readFileSync(inputPath);
const extension = extname(inputPath).toLowerCase();
const contentType = extension === ".png" ? "image/png" : "image/jpeg";
const inputSha256 = createHash("sha256").update(input).digest("hex");

async function waitForHealth(timeoutMs = 180_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${endpoint}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok)
        return {
          body: await response.json(),
          elapsedMs: performance.now() - startedAt,
        };
      await response.body?.cancel();
    } catch {
      // Container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`CPU provider did not become ready at ${endpoint}`);
}

async function scan(label, idempotencyKey) {
  const form = new FormData();
  form.set(
    "page",
    new Blob([input], { type: contentType }),
    `benchmark${extension}`,
  );
  form.set("detectTitle", "false");
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}/v1/scan-page`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
      Accept: "application/json",
    },
    body: form,
    signal: AbortSignal.timeout(
      Number(process.env.HOMR_LOCAL_REQUEST_TIMEOUT_MS || 1_860_000),
    ),
  });
  const elapsedMs = performance.now() - startedAt;
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${label} failed (${response.status}): ${body.detail || "unknown error"}`,
    );
  const musicXml = Buffer.from(String(body.musicXmlBase64 || ""), "base64");
  if (body.inputSha256 !== inputSha256)
    throw new Error(`${label} returned the wrong input digest`);
  if (body.executionProvider !== "CPUExecutionProvider") {
    throw new Error(`${label} did not use CPUExecutionProvider`);
  }
  if (!musicXml.includes(Buffer.from("<score-")))
    throw new Error(`${label} returned invalid MusicXML`);
  return {
    label,
    elapsedMs: Math.round(elapsedMs),
    musicXmlBytes: musicXml.length,
    musicXmlSha256: createHash("sha256").update(musicXml).digest("hex"),
    serviceRevision: body.serviceRevision,
    homrRevision: body.homrRevision,
    executionProvider: body.executionProvider,
  };
}

async function containerStats() {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", container],
      { encoding: "utf8", timeout: 5_000 },
    );
    return stdout.trim() ? JSON.parse(stdout.trim()) : undefined;
  } catch {
    return undefined;
  }
}

function memoryBytes(value) {
  const match = String(value || "").match(/^([0-9.]+)([KMG]iB)/i);
  if (!match) return undefined;
  const factors = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
  return Math.round(Number(match[1]) * factors[match[2].toLowerCase()]);
}

async function measuredScan(label, idempotencyKey) {
  let outcome;
  const request = scan(label, idempotencyKey).then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  const samples = [];
  while (!outcome) {
    const stats = await containerStats();
    if (stats) samples.push(stats);
    if (!outcome) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await request;
  if (outcome.error) throw outcome.error;
  const memorySamples = samples
    .map((sample) =>
      memoryBytes(
        String(sample.MemUsage || "")
          .split("/")[0]
          .trim(),
      ),
    )
    .filter((value) => Number.isFinite(value));
  const cpuSamples = samples
    .map((sample) =>
      Number.parseFloat(String(sample.CPUPerc || "").replace("%", "")),
    )
    .filter((value) => Number.isFinite(value));
  return {
    ...outcome.value,
    resourceSamples: samples.length,
    peakMemoryBytes: memorySamples.length
      ? Math.max(...memorySamples)
      : undefined,
    peakCpuPercent: cpuSamples.length ? Math.max(...cpuSamples) : undefined,
  };
}

async function main() {
  let coldStartMs;
  if (shouldRestart) {
    const restartStartedAt = performance.now();
    execFileSync("docker", ["restart", container], { stdio: "ignore" });
    await waitForHealth();
    coldStartMs = Math.round(performance.now() - restartStartedAt);
  }
  const health = (await waitForHealth()).body;
  const runId = `${Date.now()}:${process.pid}`;
  const keyPrefix = createHash("sha256")
    .update(`${inputSha256}:cpu-benchmark:${runId}:first`)
    .digest("hex");
  const first = await measuredScan("first inference", keyPrefix);
  const secondKey = createHash("sha256")
    .update(`${inputSha256}:cpu-benchmark:${runId}:second`)
    .digest("hex");
  const second = await measuredScan("second inference", secondKey);
  const cached = await scan("idempotency replay", secondKey);

  console.log(
    JSON.stringify(
      {
        benchmarkVersion: 1,
        timestamp: new Date().toISOString(),
        input: {
          filename: basename(inputPath),
          bytes: input.length,
          sha256: inputSha256,
        },
        endpoint,
        coldStartMs,
        health,
        runs: [first, second, cached],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
