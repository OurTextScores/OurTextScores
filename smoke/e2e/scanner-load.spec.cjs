// @ts-check
const { createHmac } = require("node:crypto");
const { test, expect } = require("@playwright/test");

const PUBLIC_API = process.env.PUBLIC_API || "http://localhost:4000/api";
const USER_COUNT = Number(process.env.SCANNER_LOAD_USER_COUNT || 10);
const PAGE_COUNT = Number(process.env.SCANNER_LOAD_PAGE_COUNT || 20);
const SAMPLE_INTERVAL_MS = Number(
  process.env.SCANNER_LOAD_SAMPLE_INTERVAL_MS || 750,
);
const P95_LIMIT_MS = Number(process.env.SCANNER_LOAD_P95_LIMIT_MS || 1_000);
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
const PROCESSING_STATUSES = new Set(["running", "rendering"]);

function b64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(email) {
  const secret = process.env.NEXTAUTH_SECRET || "dev-secret";
  const header = b64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const now = Math.floor(Date.now() / 1_000);
  const payload = b64url(
    Buffer.from(
      JSON.stringify({ sub: email, email, iat: now, exp: now + 3_600 }),
    ),
  );
  const data = `${header}.${payload}`;
  const signature = b64url(
    createHmac("sha256", secret).update(data).digest(),
  );
  return `${data}.${signature}`;
}

function pdfWithPages(pageCount) {
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const pageReferences = Array.from(
    { length: pageCount },
    (_value, index) => `${firstPageObject + index} 0 R`,
  ).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      (_value, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources <<>> /Contents ${firstContentObject + index} 0 R >>`,
    ),
    ...Array.from(
      { length: pageCount },
      () => "<< /Length 0 >>\nstream\n\nendstream",
    ),
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function percentile(values, proportion) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * proportion) - 1);
  return ordered[index];
}

function summary(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...values).toFixed(1)),
  };
}

async function timedGet(request, url) {
  const startedAt = performance.now();
  const response = await request.get(url, { timeout: 5_000 });
  const durationMs = performance.now() - startedAt;
  const status = response.status();
  await response.dispose();
  expect(status, `${url} should remain available`).toBe(200);
  return durationMs;
}

async function sampleApi(request, samples) {
  const [healthMs, worksMs] = await Promise.all([
    timedGet(request, `${PUBLIC_API}/health`),
    timedGet(request, `${PUBLIC_API}/works?limit=1`),
  ]);
  samples.health.push(healthMs);
  samples.works.push(worksMs);
}

async function readJob(request, descriptor) {
  const response = await request.get(
    `${PUBLIC_API}/scanner/jobs/${descriptor.jobId}`,
    { headers: { Authorization: `Bearer ${descriptor.token}` } },
  );
  expect(response.status(), `read Scanner job ${descriptor.jobId}`).toBe(200);
  const job = await response.json();
  await response.dispose();
  return job;
}

async function waitForJobs({
  request,
  descriptors,
  label,
  timeoutMs,
  samples,
  done,
  observe,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const jobs = await Promise.all(
      descriptors.map((descriptor) => readJob(request, descriptor)),
    );
    if (observe) observe(jobs);
    if (done(jobs)) return jobs;
    await sampleApi(request, samples);
    await sleep(SAMPLE_INTERVAL_MS);
  }
  const jobs = await Promise.all(
    descriptors.map((descriptor) => readJob(request, descriptor)),
  );
  throw new Error(
    `Timed out waiting for ${label}: ${jobs.map((job) => `${job.jobId}:${job.status}`).join(", ")}`,
  );
}

test.describe("Scanner multi-user load", () => {
  test.skip(
    process.env.SCANNER_LOAD !== "1",
    "Run with the Scanner load Compose profile",
  );

  test("keeps the main API responsive while maximum-page jobs run FIFO", async ({
    request,
  }) => {
    test.setTimeout(20 * 60 * 1_000);
    expect(USER_COUNT).toBeGreaterThanOrEqual(2);
    expect(PAGE_COUNT).toBeGreaterThanOrEqual(1);
    expect(PAGE_COUNT).toBeLessThanOrEqual(20);

    const baseline = { health: [], works: [] };
    for (let index = 0; index < 15; index += 1) {
      await sampleApi(request, baseline);
      await sleep(50);
    }

    const pdf = pdfWithPages(PAGE_COUNT);
    const runId = Date.now();
    const descriptors = [];
    for (let index = 0; index < USER_COUNT; index += 1) {
      const email = `scanner_load_${runId}_${String(index + 1).padStart(2, "0")}@example.test`;
      const token = makeJwt(email);
      const response = await request.post(`${PUBLIC_API}/scanner/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          file: {
            name: `load-${String(index + 1).padStart(2, "0")}-${PAGE_COUNT}-pages.pdf`,
            mimeType: "application/pdf",
            buffer: pdf,
          },
          detectTitle: "false",
        },
        timeout: 120_000,
      });
      // 202 Accepted: the job is queued for asynchronous preparation.
      expect(response.status(), `create Scanner job for ${email}`).toBe(202);
      expect(response.headers()["location"]).toContain("/api/scanner/jobs/");
      const job = await response.json();
      await response.dispose();
      expect(job).toMatchObject({ status: "preparing", pageCount: PAGE_COUNT });
      descriptors.push({ email, token, jobId: job.jobId });
    }

    const preparation = { health: [], works: [] };
    await waitForJobs({
      request,
      descriptors,
      label: "all jobs to be prepared",
      timeoutMs: 8 * 60 * 1_000,
      samples: preparation,
      done: (jobs) => jobs.every((job) => job.status === "ready"),
    });

    await Promise.all(
      descriptors.map(async (descriptor) => {
        const response = await request.post(
          `${PUBLIC_API}/scanner/jobs/${descriptor.jobId}/start`,
          { headers: { Authorization: `Bearer ${descriptor.token}` } },
        );
        expect(response.status(), `queue Scanner job ${descriptor.jobId}`).toBe(
          201,
        );
        const job = await response.json();
        await response.dispose();
        expect(job.status).toBe("queued");
      }),
    );

    const processing = { health: [], works: [] };
    const activeOrder = [];
    const completedOrder = [];
    const seenActive = new Set();
    const seenCompleted = new Set();
    const completed = await waitForJobs({
      request,
      descriptors,
      label: "all queued jobs to finish",
      timeoutMs: 15 * 60 * 1_000,
      samples: processing,
      observe: (jobs) => {
        const active = jobs.filter((job) => PROCESSING_STATUSES.has(job.status));
        expect(
          active.length,
          "the single worker must not overlap jobs",
        ).toBeLessThanOrEqual(1);
        for (const job of active) {
          if (!seenActive.has(job.jobId)) {
            seenActive.add(job.jobId);
            activeOrder.push(job.jobId);
          }
        }
        for (const job of jobs) {
          if (TERMINAL_STATUSES.has(job.status) && !seenCompleted.has(job.jobId)) {
            seenCompleted.add(job.jobId);
            completedOrder.push(job.jobId);
          }
        }
      },
      done: (jobs) => jobs.every((job) => TERMINAL_STATUSES.has(job.status)),
    });

    const expectedOrder = descriptors.map((descriptor) => descriptor.jobId);
    expect(activeOrder.length).toBeGreaterThan(0);
    expect(
      activeOrder.map((jobId) => expectedOrder.indexOf(jobId)),
      "sampled active jobs should never move backward in the FIFO queue",
    ).toEqual(
      [...activeOrder]
        .map((jobId) => expectedOrder.indexOf(jobId))
        .sort((left, right) => left - right),
    );
    expect(completedOrder).toEqual(expectedOrder);
    expect(completed).toHaveLength(USER_COUNT);
    const startedOrder = [...completed]
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt),
      )
      .map((job) => job.jobId);
    const finishedOrder = [...completed]
      .sort(
        (left, right) =>
          Date.parse(left.completedAt) - Date.parse(right.completedAt),
      )
      .map((job) => job.jobId);
    expect(startedOrder).toEqual(expectedOrder);
    expect(finishedOrder).toEqual(expectedOrder);
    for (const job of completed) {
      expect(job).toMatchObject({
        status: "succeeded",
        pageCount: PAGE_COUNT,
        includedPageCount: PAGE_COUNT,
        hasPdf: true,
        hasZip: true,
      });
      expect(job.pages).toHaveLength(PAGE_COUNT);
      expect(
        job.pages.every(
          (page) =>
            page.status === "succeeded" &&
            page.attempts === 1 &&
            page.hasMusicXml &&
            page.hasPdf,
        ),
      ).toBe(true);
    }

    const loaded = {
      health: [...preparation.health, ...processing.health],
      works: [...preparation.works, ...processing.works],
    };
    expect(loaded.health.length).toBeGreaterThanOrEqual(10);
    expect(loaded.works.length).toBeGreaterThanOrEqual(10);
    const report = {
      workload: { users: USER_COUNT, pagesPerJob: PAGE_COUNT },
      baseline: {
        health: summary(baseline.health),
        works: summary(baseline.works),
      },
      loaded: {
        health: summary(loaded.health),
        works: summary(loaded.works),
      },
    };
    console.log(`Scanner load report: ${JSON.stringify(report)}`);

    for (const endpoint of ["health", "works"]) {
      const loadedP95 = report.loaded[endpoint].p95Ms;
      const relativeLimit = report.baseline[endpoint].p95Ms * 10;
      expect(
        loadedP95,
        `${endpoint} loaded p95 should stay within the responsiveness guard`,
      ).toBeLessThanOrEqual(Math.max(P95_LIMIT_MS, relativeLimit));
    }
  });
});
