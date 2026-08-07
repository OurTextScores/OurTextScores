// @ts-check
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";
const WORKER_CONTAINER =
  process.env.SCANNER_WORKER_CONTAINER || "ourtextscores_scanner_worker";

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
      if (!detail.ok()) continue;
      const data = await detail.json();
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
  throw new Error("Scanner recovery sign-in link was not received");
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

test.describe("Scanner worker recovery", () => {
  test.skip(
    process.env.SCANNER_RECOVERY !== "1",
    "Run with the Scanner recovery Compose profile",
  );

  test("recovers a 20-page job after the worker is killed", async ({
    page,
    request,
  }) => {
    test.setTimeout(6 * 60 * 1_000);
    const email = `scanner_recovery_${Date.now()}@example.test`;
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
    await expect(page.getByText("20 of 20 pages included")).toBeVisible();
    await page.getByRole("button", { name: "Start scanning" }).click();

    await expect
      .poll(
        async () => {
          const job = await readJob(page);
          return job.pages.filter((item) => item.status === "succeeded").length;
        },
        { timeout: 180_000, intervals: [250, 500, 1_000] },
      )
      .toBeGreaterThanOrEqual(2);
    const beforeRestart = await readJob(page);
    expect(["running", "rendering"]).toContain(beforeRestart.status);
    const preservedPageNumbers = beforeRestart.pages
      .filter((item) => item.status === "succeeded")
      .map((item) => item.pageNumber);
    expect(preservedPageNumbers.length).toBeGreaterThanOrEqual(2);
    expect(preservedPageNumbers.length).toBeLessThan(20);

    execFileSync("docker", ["restart", "--timeout", "0", WORKER_CONTAINER], {
      stdio: "ignore",
      timeout: 30_000,
    });
    const apiStatus = await page.evaluate(async () =>
      fetch("/api/proxy/scanner/jobs", { cache: "no-store" }).then(
        (response) => response.status,
      ),
    );
    expect(apiStatus).toBe(200);

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
    for (const pageNumber of preservedPageNumbers) {
      expect(
        completed.pages.find((item) => item.pageNumber === pageNumber),
      ).toMatchObject({ status: "succeeded", attempts: 1 });
    }

    const zipContents = await page.evaluate(async () => {
      const response = await fetch(
        `${window.location.pathname.replace("/scanner/", "/api/proxy/scanner/jobs/")}/artifacts/zip`,
      );
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
