// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const fixtureSource = readFileSync(
  join(__dirname, "../fixtures/scanner-review-workflow.cjs"),
  "utf8",
);
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SOURCE_JOB = process.env.SCANNER_REVIEW_SOURCE_JOB_ID;
function fixture(operation, options) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        process.env.SCANNER_API_CONTAINER || "ourtextscores_backend",
        "node",
        "-",
        operation,
        JSON.stringify(options),
      ],
      { input: fixtureSource, encoding: "utf8", timeout: 60000 },
    ),
  );
}
async function json(page, path) {
  const response = await page.request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test.describe("Scanner engine merge with persisted work", () => {
  test.skip(
    process.env.SCANNER_REVIEW_WORKFLOW !== "1",
    "Opt in with SCANNER_REVIEW_WORKFLOW=1 and SCANNER_REVIEW_SOURCE_JOB_ID",
  );
  test.setTimeout(300000);
  test.use({ actionTimeout: 20000 });
  let current;
  test.beforeAll(async ({ request }) => {
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(`${BASE_URL}/api/health`)).ok();
          } catch {
            return false;
          }
        },
        { timeout: 60000 },
      )
      .toBe(true);
  });
  test.beforeEach(async ({ page, context }) => {
    expect(
      SOURCE_JOB,
      "Provide a retained completed scan; tests only modify isolated copies",
    ).toBeTruthy();
    const jobId = randomUUID();
    const email = `scanner-review-e2e-${jobId}@example.test`;
    current = {
      jobId,
      email,
      ...fixture("seed", { sourceJobId: SOURCE_JOB, jobId, email }),
    };
    await context.addCookies([
      {
        name: "next-auth.session-token",
        url: BASE_URL,
        value: await encode({
          token: { email, sub: email, name: "Scanner review E2E" },
          secret: process.env.NEXTAUTH_SECRET,
          maxAge: 3600,
        }),
      },
    ]);
    current.analyticsRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/_vercel/insights/script.js"))
        current?.analyticsRequests.push(request.url());
    });
  });
  test.afterEach(async ({ page }) => {
    if (!current) return;
    // Let derivative rebuilding publish its artifacts before removing only the test copy.
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/proxy/scanner/jobs/${current.jobId}`,
          );
          return response.ok() ? (await response.json()).status : "missing";
        },
        { timeout: 120000 },
      )
      .toBe("succeeded");
    expect(current.analyticsRequests).toEqual([]);
    fixture("cleanup", current);
    current = undefined;
  });

  const root = () => `/api/proxy/scanner/jobs/${current.jobId}`;
  const editor = (page) =>
    page.frameLocator(
      'iframe[title^="Reconciling difference"], iframe[title^="Reviewing page"]',
    );
  async function flag(page) {
    const button = editor(page)
      .getByRole("button", { name: "Skip conflict", exact: true })
      .first();
    await expect(button).toBeEnabled({ timeout: 180000 });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/merged/decisions/flag"),
    );
    await button.dispatchEvent("click");
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    return json(page, `${root()}/pages/${current.pageNumber}/merged`);
  }
  async function stage(page, action) {
    const latest = await json(page, root());
    const p = latest.pages.find(
      (entry) => entry.pageNumber === current.pageNumber,
    );
    const response = await page.request.post(
      `${root()}/pages/${current.pageNumber}/review-workflow`,
      {
        data: {
          action,
          statusVersion: latest.statusVersion,
          workflowStateVersion: p.reviewWorkflow?.stateVersion ?? null,
        },
      },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  test("opens directly in the engine merge and preserves decisions after reload and reopening", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    await expect(
      page.getByRole("button", { name: "Start guided review" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Prepare additional heads merge" }),
    ).toHaveCount(0);
    const saved = await flag(page);
    expect(saved.decisions.length).toBeGreaterThan(0);
    await page.reload();
    await expect(
      editor(page)
        .getByRole("button", { name: "Reopen conflict", exact: true })
        .first(),
    ).toBeEnabled({ timeout: 180000 });
    expect(
      (await json(page, `${root()}/pages/${current.pageNumber}/merged`))
        .decisions,
    ).toEqual(saved.decisions);
    await page.goto(
      `${BASE_URL}/scanner/${current.jobId}/pages/${current.pageNumber}/compare`,
    );
    await expect(
      editor(page)
        .getByRole("button", { name: "Reopen conflict", exact: true })
        .first(),
    ).toBeEnabled({ timeout: 180000 });
    expect(
      (await json(page, `${root()}/pages/${current.pageNumber}/merged`))
        .checksumSha256,
    ).toBe(saved.checksumSha256);
  });

  test("draws merged notes on later engraved pages", async ({ page }) => {
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    const frame = editor(page);
    const pane = frame.getByTestId("merged-system-pane").first();
    await expect(pane).toBeVisible({ timeout: 180000 });
    // Include later engraved pages when the retained score spans multiple pages.
    const title = frame.getByTestId("difference-title");
    const count = Number((await title.textContent()).match(/of (\d+)/)?.[1]);
    expect(count).toBeGreaterThan(0);
    for (let line = 1; line <= count; line += 1) {
      await expect(title).toContainText(`line ${line} of`);
      await expect
        .poll(
          () => pane.evaluate((element) => {
            const clip = element.getBoundingClientRect();
            const shapes = element.querySelectorAll("svg path, svg use, svg line, svg text");
            return [...shapes].filter((ink) => {
              if (ink.closest("defs")) return false;
              const bounds = ink.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0 &&
                bounds.right > clip.left && bounds.left < clip.right &&
                bounds.bottom > clip.top && bounds.top < clip.bottom;
            }).length;
          }),
          { timeout: 30000, message: `Visible merged music on conflict ${line}` },
        )
        .toBeGreaterThan(10);
      if (line < count) await frame.getByTestId("btn-next-difference").click();
    }
  });

  test("keeps pane widths stable when switching from across to stacked", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    const frame = editor(page);
    await expect(frame.getByTestId("merged-system-pane").first()).toBeVisible({
      timeout: 180000,
    });
    await frame.getByTestId("btn-layout-horizontal").click();
    await frame.locator("html").evaluate(async (root) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      window.__scannerLayoutSamples = [];
      window.__scannerLayoutSamplingDone = false;
      const started = performance.now();
      const sample = () => {
        const pane = document.querySelector(
          '[data-testid="merged-system-pane"]',
        );
        const stacked =
          document
            .querySelector('[data-testid="btn-layout-vertical"]')
            ?.getAttribute("aria-pressed") === "true";
        window.__scannerLayoutSamples.push({
          width: document.body.getBoundingClientRect().width,
          gutter:
            window.innerWidth - document.body.getBoundingClientRect().width,
          height: pane?.getBoundingClientRect().height || 0,
          stacked,
        });
        if (performance.now() - started < 2500) requestAnimationFrame(sample);
        else window.__scannerLayoutSamplingDone = true;
      };
      requestAnimationFrame(sample);
    });
    await frame.getByTestId("btn-layout-vertical").click();
    await expect
      .poll(
        () =>
          frame
            .locator("html")
            .evaluate(() => window.__scannerLayoutSamplingDone),
        { timeout: 30000 },
      )
      .toBe(true);
    const samples = await frame
      .locator("html")
      .evaluate(() => window.__scannerLayoutSamples);
    console.log(
      "Layout samples",
      JSON.stringify({
        widths: [...new Set(samples.map((sample) => sample.width))],
        gutter: samples[0].gutter,
        frames: samples.length,
      }),
    );
    expect(samples.some((sample) => sample.stacked)).toBe(true);
    expect(new Set(samples.map((sample) => sample.width)).size).toBe(1);
    if (process.env.SCANNER_CLASSIC_SCROLLBARS === "1")
      expect(samples[0].gutter).toBeGreaterThan(0);
    const heights = samples
      .filter((sample) => sample.stacked)
      .map((sample) => sample.height)
      .filter(
        (height, index, all) =>
          index === 0 || Math.abs(height - all[index - 1]) > 2,
      );
    for (let index = 2; index < heights.length; index += 1) {
      expect(Math.abs(heights[index] - heights[index - 2])).toBeGreaterThan(2);
    }
    const tail = samples
      .slice(-Math.max(3, Math.floor(samples.length / 3)))
      .map((sample) => sample.height);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(2);
    const iframe = page.locator('iframe[title^="Reconciling difference"]');
    await iframe.scrollIntoViewIfNeeded();
    const box = await iframe.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box.x + box.width / 2, Math.max(10, box.y + 100));
    const position = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(position);
  });

  test("automatically carries an older additional-heads result into the single engine merge", async ({
    page,
  }) => {
    await stage(page, "start");
    await stage(page, "complete");
    fixture("legacy-heads", current);
    const prefix = `${root()}/pages/${current.pageNumber}`;
    const currentMerge = await json(page, `${prefix}/merged`);
    const kept = await page.request.post(`${prefix}/merged/source`, {
      data: {
        engineId: "ots-homr-selected-heads",
        baseEngine: "ots-homr-core",
        candidateEngine: "ots-homr-selected-heads",
        revision: currentMerge.revision,
      },
    });
    expect(kept.ok(), await kept.text()).toBeTruthy();
    const heads = await json(page, `${prefix}/merged`);
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    await expect(
      editor(page)
        .getByRole("button", { name: "Skip conflict", exact: true })
        .first(),
    ).toBeEnabled({ timeout: 180000 });
    const comparison = await json(
      page,
      `${prefix}/comparison?baseEngine=ots-homr&candidateEngine=${current.candidateEngine}`,
    );
    expect(comparison.base.artifactChecksumSha256).toBe(heads.checksumSha256);
    expect(fixture("inspect", current)).toMatchObject({
      active: "engines",
      compact: true,
    });
    expect(fixture("inspect", current).bsonBytes).toBeLessThan(
      16 * 1024 * 1024,
    );
  });

  test("refreshes a stale comparison internally without navigating the page", async ({
    page,
  }) => {
    let calls = 0;
    await page.route("**/pages/*/comparison?*", async (route) => {
      if (++calls === 1)
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message: "Scanner comparison changed; refresh and try again",
          }),
        });
      else await route.continue();
    });
    let navigations = 0;
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        request.resourceType() === "document"
      )
        navigations += 1;
    });
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    await expect(
      editor(page)
        .getByRole("button", { name: "Skip conflict", exact: true })
        .first(),
    ).toBeEnabled({ timeout: 180000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(navigations).toBe(1);
    await expect(page.getByText(/refresh and try again/)).toHaveCount(0);
  });

  test("keeps the same scan crop valid when a merge save changes the job version", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/scanner/${current.jobId}`);
    const prefix = `${root()}/pages/${current.pageNumber}/comparison`;
    const regionsUrl = `${BASE_URL}${prefix}/regions?baseEngine=ots-homr&candidateEngine=${current.candidateEngine}`;
    const regions = await json(page, regionsUrl);
    const cropUrl = new URL(regions.systems[0].cropUrl, regionsUrl).toString();
    expect(
      new URL(cropUrl).searchParams.get("rasterChecksumSha256"),
    ).toBeTruthy();
    const before = await page.request.get(cropUrl);
    expect(before.ok()).toBeTruthy();
    const pixels = await before.body();
    await flag(page);
    const latest = await json(page, root());
    expect(latest.statusVersion).toBeGreaterThan(regions.statusVersion);
    const after = await page.request.get(cropUrl);
    expect(after.ok(), await after.text()).toBeTruthy();
    expect(await after.body()).toEqual(pixels);
    await expect(
      editor(page).getByText(/scan crop is no longer current/i),
    ).toHaveCount(0);
  });
});
