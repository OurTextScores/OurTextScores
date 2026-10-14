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
function otsQuestions(page) {
  return page.locator("details").filter({
    has: page.getByRole("heading", {
      name: "Check OTS-HOMR's base recognition",
      exact: true,
    }),
  });
}
async function clickAndSave(page, button, urlPart) {
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" && value.url().includes(urlPart),
  );
  await button.click();
  const result = await response;
  const body = await result.json();
  expect(result.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

test.describe("Guided scanner review with real persisted checkpoints", () => {
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
    await page.goto(`${BASE_URL}/scanner/${jobId}`);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Start guided review" }),
      "/review-workflow",
    );
    await expect(otsQuestions(page)).toBeVisible();
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

  test("a legacy recognition choice saves and resumes without a repeated 409 loop", async ({
    page,
  }) => {
    const requests = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/corrections"))
        requests.push(response.status());
    });
    const button = otsQuestions(page).locator("li button").first();
    await expect(button).toBeEnabled();
    const result = await clickAndSave(page, button, "/corrections");
    expect(result.pending).toBe(true);
    await expect(otsQuestions(page).getByRole("status")).toContainText(
      "Updating the score",
    );
    await expect(
      otsQuestions(page).locator("li button").first(),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Skip base review", exact: true }),
    ).toBeDisabled();
    // A reload during rebuilding must resume the wait instead of exposing the
    // edited proposal's temporary question signature.
    await page.reload();
    await expect(otsQuestions(page).locator("li button").first()).toBeEnabled({
      timeout: 180000,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeGreaterThanOrEqual(200);
    expect(requests[0]).toBeLessThan(300);
    const savedJob = await json(
      page,
      `/api/proxy/scanner/jobs/${current.jobId}`,
    );
    const savedRun = savedJob.pages.find(
      (entry) => entry.pageNumber === current.pageNumber,
    ).engines["ots-homr"];
    expect(savedRun.structuredOutputError).toBeFalsy();
    expect(savedRun.structuredOutputPending).toBe(false);
    expect(savedRun.structuredOutputRetryable).toBe(false);
    await clickAndSave(
      page,
      otsQuestions(page).locator("li button").first(),
      "/corrections",
    );
    await expect(otsQuestions(page).locator("li button").first()).toBeEnabled({
      timeout: 180000,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((status) => status >= 200 && status < 300)).toBe(
      true,
    );
    await expect(
      page.getByText("This page changed while you were reviewing it.", {
        exact: false,
      }),
    ).toHaveCount(0);
    await page.reload();
    await expect(otsQuestions(page)).toBeVisible();
    const state = fixture("inspect", current);
    expect(state.compact).toBe(true);
    expect(state.bsonBytes).toBeLessThan(16 * 1024 * 1024);
  });

  test("permanent conflicts show their real reason while stale conflicts can be refreshed and retried", async ({
    page,
  }) => {
    let failures = 0;
    await page.route("**/pages/*/corrections", async (route) => {
      failures += 1;
      if (failures === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            message:
              "This retained result cannot map the review choice to its final symbol; rescan and try again",
          }),
        });
      } else if (failures === 2) {
        await route.continue({
          postData: JSON.stringify({
            ...route.request().postDataJSON(),
            contentSignature: "stale-test-signature",
          }),
        });
      } else await route.continue();
    });
    await otsQuestions(page).locator("li button").first().click();
    await expect(
      otsQuestions(page).getByText(/cannot map the review choice/),
    ).toBeVisible();
    await expect(
      page.getByText(/This page changed while you were reviewing/),
    ).toHaveCount(0);
    await otsQuestions(page).locator("li button").first().click();
    await expect(
      otsQuestions(page).getByText(
        /This page changed while you were reviewing/,
      ),
    ).toBeVisible();
    await clickAndSave(
      page,
      otsQuestions(page).locator("li button").first(),
      "/corrections",
    );
    await expect(otsQuestions(page).locator("li button").first()).toBeEnabled({
      timeout: 180000,
    });
    await expect(
      page.getByText(/This page changed while you were reviewing/),
    ).toHaveCount(0);
  });

  test("can skip every stage, reload the completed review, and return to base questions", async ({
    page,
  }) => {
    for (const name of [
      "Skip base review",
      "Skip additional heads",
      "Skip engine merge",
    ]) {
      await clickAndSave(
        page,
        page.getByRole("button", { name, exact: true }),
        "/review-workflow",
      );
    }
    await expect(
      page.getByRole("button", { name: "Review complete · saved" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Skipped · saved", { exact: true }),
    ).toHaveCount(3);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Redo 1", exact: true }),
      "/review-workflow",
    );
    await expect(otsQuestions(page)).toBeVisible();
    const state = fixture("inspect", current);
    expect(state.compact).toBe(true);
    expect(state.bsonBytes).toBeLessThan(16 * 1024 * 1024);
  });

  test("can keep the base reading as the heads checkpoint without making merge edits", async ({
    page,
  }) => {
    const base = `/api/proxy/scanner/jobs/${current.jobId}/pages/${current.pageNumber}`;
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Save base review and continue" }),
      "/review-workflow",
    );
    for (const checkbox of await page
      .getByRole("group", { name: "Additional heads" })
      .getByRole("checkbox")
      .all()) {
      await expect(checkbox).toBeChecked();
      await checkbox.uncheck();
    }
    await page
      .getByRole("checkbox", { name: "Stem direction", exact: true })
      .check();
    const prepared = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/structured-output"),
    );
    await page
      .getByRole("button", { name: "Prepare additional heads merge" })
      .click();
    expect((await prepared).ok()).toBeTruthy();
    const keep = page.getByRole("button", {
      name: "Keep base recognition for this step",
    });
    await expect(keep).toBeVisible({ timeout: 180000 });
    await clickAndSave(page, keep, "/merged/source");
    const checkpoint = await json(page, `${base}/merged`);
    expect(checkpoint.present).toBe(true);
    expect(checkpoint.sourceEngineId).toBe("ots-homr-core");
    expect(checkpoint.decisions).toEqual([]);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Save additional heads and continue" }),
      "/review-workflow",
    );
    const comparison = await json(
      page,
      `${base}/comparison?baseEngine=ots-homr&candidateEngine=${current.candidateEngine}`,
    );
    expect(comparison.base.artifactChecksumSha256).toBe(
      checkpoint.checksumSha256,
    );
  });

  test("steps save independently, survive reloads, and carry the heads result into the engine merge", async ({
    page,
  }) => {
    const base = `/api/proxy/scanner/jobs/${current.jobId}/pages/${current.pageNumber}`;
    await clickAndSave(
      page,
      otsQuestions(page).locator("li button").first(),
      "/corrections",
    );
    await expect(otsQuestions(page).locator("li button").first()).toBeEnabled({
      timeout: 180000,
    });
    await clickAndSave(
      page,
      otsQuestions(page).getByRole("button", { name: "Skip", exact: true }),
      "/review-workflow",
    );
    await page.reload();
    await expect(otsQuestions(page).getByText(/question 2 of/)).toBeVisible();
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Save base review and continue" }),
      "/review-workflow",
    );
    for (const checkbox of await page
      .getByRole("group", { name: "Additional heads", exact: true })
      .getByRole("checkbox")
      .all()) {
      await checkbox.check();
    }
    const prepared = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/structured-output"),
    );
    await page
      .getByRole("button", { name: "Prepare additional heads merge" })
      .click();
    const preparedResponse = await prepared;
    expect(preparedResponse.ok(), await preparedResponse.text()).toBeTruthy();
    const editor = page.frameLocator(
      'iframe[title^="Reconciling difference"], iframe[title^="Reviewing page"]',
    );
    const skip = editor
      .getByRole("button", { name: "Skip conflict", exact: true })
      .first();
    await expect(skip).toBeEnabled({ timeout: 180000 });
    const headsSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/merged/decisions/flag"),
    );
    await skip.dispatchEvent("click");
    expect((await headsSave).ok()).toBeTruthy();
    const heads = await json(page, `${base}/merged`);
    expect(heads.present).toBe(true);
    expect(heads.decisions.some((decision) => decision.flagged)).toBe(true);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Save additional heads and continue" }),
      "/review-workflow",
    );
    const comparison = await json(
      page,
      `${base}/comparison?baseEngine=ots-homr&candidateEngine=${current.candidateEngine}`,
    );
    expect(comparison.base.artifactChecksumSha256).toBe(heads.checksumSha256);
    await expect(
      editor
        .getByRole("button", { name: "Skip conflict", exact: true })
        .first(),
    ).toBeEnabled({ timeout: 180000 });
    const engineSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/merged/decisions/flag"),
    );
    await editor
      .getByRole("button", { name: "Skip conflict", exact: true })
      .first()
      .dispatchEvent("click");
    expect((await engineSave).ok()).toBeTruthy();
    const engines = await json(page, `${base}/merged`);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Finish review", exact: true }),
      "/review-workflow",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Review complete · saved" }),
    ).toBeVisible();
    await clickAndSave(
      page,
      page.getByRole("button", { name: "2. Merge additional heads" }),
      "/review-workflow",
    );
    expect((await json(page, `${base}/merged`)).checksumSha256).toBe(
      heads.checksumSha256,
    );
    await clickAndSave(
      page,
      page.getByRole("button", { name: "3. Merge between engines" }),
      "/review-workflow",
    );
    const restored = await json(page, `${base}/merged`);
    expect(restored.checksumSha256).toBe(engines.checksumSha256);
    expect(restored.decisions).toEqual(engines.decisions);
    await clickAndSave(
      page,
      page.getByRole("button", { name: "Redo 1", exact: true }),
      "/review-workflow",
    );
    await expect(otsQuestions(page)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download previous result" }).first(),
    ).toBeVisible();
    await expect(page.getByText("Saved work needs updated input")).toHaveCount(
      2,
    );
    expect(fixture("inspect", current).compact).toBe(true);
  });
});
