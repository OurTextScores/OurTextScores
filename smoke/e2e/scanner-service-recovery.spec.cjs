// @ts-check
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PUBLIC_API = process.env.PUBLIC_API || "http://localhost:4000/api";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";
const BACKEND_CONTAINER =
  process.env.SCANNER_BACKEND_CONTAINER || "ourtextscores_backend";
const FRONTEND_CONTAINER =
  process.env.SCANNER_FRONTEND_CONTAINER || "ourtextscores_frontend";
const WORKER_CONTAINER =
  process.env.SCANNER_WORKER_CONTAINER || "ourtextscores_scanner_worker";

function containerStartedAt(container) {
  return execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.StartedAt}}", container],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
}

function restartContainer(container) {
  execFileSync("docker", ["restart", "--timeout", "0", container], {
    stdio: "ignore",
    timeout: 30_000,
  });
}

async function waitForHttp(request, url, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request.get(url, { timeout: 5_000 });
      const status = response.status();
      await response.dispose();
      if (status === 200) return;
    } catch {
      // A connection failure is expected while Docker replaces the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function signInViaEmail(page, request, email) {
  await page.goto(`${BASE_URL}/api/auth/signin`);
  const input = page.locator('input[type="email"][name="email"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(email);
  await input.press("Enter");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const response = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
    const messages = response.ok()
      ? (await response.json()).messages || []
      : [];
    await response.dispose();
    for (const message of messages) {
      const recipients = (message.To || []).map(
        (value) => value.Address || value.address || value,
      );
      if (
        !recipients.some((value) =>
          String(value).toLowerCase().includes(email.toLowerCase()),
        )
      )
        continue;
      const detail = await request.get(
        `${MAILPIT}/api/v1/message/${message.ID || message.Id || message.id}`,
      );
      if (!detail.ok()) {
        await detail.dispose();
        continue;
      }
      const data = await detail.json();
      await detail.dispose();
      const match = `${data.HTML || ""}\n${data.Text || ""}`.match(
        /https?:[^\s"<]+\/api\/auth\/callback\/email[^\s"<]*/i,
      );
      if (match) {
        await page.goto(match[0].replace(/&amp;/g, "&"));
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Scanner service recovery sign-in link was not received");
}

async function readJob(page) {
  return page.evaluate(async () => {
    const response = await fetch(
      window.location.pathname.replace("/scanner/", "/api/proxy/scanner/jobs/"),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Job request failed: ${response.status}`);
    return response.json();
  });
}

function succeededPages(job) {
  return job.pages.filter((item) => item.status === "succeeded").length;
}

test.describe("Scanner API and web recovery", () => {
  test.skip(
    process.env.SCANNER_SERVICE_RECOVERY !== "1",
    "Run with the Scanner service recovery Compose profile",
  );

  test("keeps a job and browser session across backend and frontend restarts", async ({
    page,
    request,
  }) => {
    test.setTimeout(8 * 60 * 1_000);
    const initialStarts = {
      backend: containerStartedAt(BACKEND_CONTAINER),
      frontend: containerStartedAt(FRONTEND_CONTAINER),
      worker: containerStartedAt(WORKER_CONTAINER),
    };

    const email = `scanner_service_recovery_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.locator("#scanner-file").setInputFiles(
      Array.from({ length: 20 }, (_value, index) => ({
        name: `page-${String(20 - index).padStart(2, "0")}.png`,
        mimeType: "image/png",
        buffer: png,
      })),
    );
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /page-01\.png \+ 19 more/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Start scanning" }).click();

    await expect
      .poll(async () => succeededPages(await readJob(page)), {
        timeout: 180_000,
        intervals: [250, 500, 1_000],
      })
      .toBeGreaterThanOrEqual(2);
    const beforeBackendRestart = await readJob(page);
    expect(["running", "rendering"]).toContain(beforeBackendRestart.status);
    expect(succeededPages(beforeBackendRestart)).toBeLessThan(20);

    restartContainer(BACKEND_CONTAINER);
    await waitForHttp(request, `${PUBLIC_API}/health`);
    expect(containerStartedAt(BACKEND_CONTAINER)).not.toBe(
      initialStarts.backend,
    );
    expect(containerStartedAt(WORKER_CONTAINER)).toBe(initialStarts.worker);

    const afterBackendRestart = await readJob(page);
    expect(succeededPages(afterBackendRestart)).toBeGreaterThanOrEqual(
      succeededPages(beforeBackendRestart),
    );
    expect(["running", "rendering"]).toContain(afterBackendRestart.status);
    expect(succeededPages(afterBackendRestart)).toBeLessThan(20);

    const pageUrl = page.url();
    restartContainer(FRONTEND_CONTAINER);
    await waitForHttp(request, `${BASE_URL}/api/diagnostics/email`);
    expect(containerStartedAt(FRONTEND_CONTAINER)).not.toBe(
      initialStarts.frontend,
    );
    expect(containerStartedAt(WORKER_CONTAINER)).toBe(initialStarts.worker);

    await page.goto(pageUrl);
    await expect(
      page.getByRole("heading", { name: /page-01\.png \+ 19 more/ }),
    ).toBeVisible({ timeout: 30_000 });
    const afterFrontendRestart = await readJob(page);
    expect(succeededPages(afterFrontendRestart)).toBeGreaterThanOrEqual(
      succeededPages(afterBackendRestart),
    );

    await expect(
      page.getByRole("link", { name: "Download all results (.zip)" }),
    ).toBeVisible({ timeout: 5 * 60 * 1_000 });
    const completed = await readJob(page);
    expect(completed.status).toBe("succeeded");
    expect(completed.pageCount).toBe(20);
    expect(completed.pages).toHaveLength(20);
    expect(completed.pages.every((item) => item.status === "succeeded")).toBe(
      true,
    );
    expect(completed.pages.every((item) => item.attempts === 1)).toBe(true);
    expect(containerStartedAt(WORKER_CONTAINER)).toBe(initialStarts.worker);

    const zipContents = await page.evaluate(async () => {
      const response = await fetch(
        `${window.location.pathname.replace("/scanner/", "/api/proxy/scanner/jobs/")}/artifacts/zip`,
      );
      if (!response.ok)
        throw new Error(`ZIP request failed: ${response.status}`);
      return new TextDecoder("latin1").decode(await response.arrayBuffer());
    });
    expect(zipContents).toContain("page-001.musicxml");
    expect(zipContents).toContain("page-020.musicxml");
    expect(zipContents).toContain("scanner-manifest.json");

    await page.goto(`${BASE_URL}/notifications`);
    await expect(page.getByText("Scan complete", { exact: true })).toHaveCount(
      1,
    );
  });
});
