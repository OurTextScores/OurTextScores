// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");

// Hold each response separately to exercise the UI while work is pending.
test("scanner shows provider and upload progress without waiting for scan history", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    process.env.SCANNER_ENABLED !== "true" &&
      process.env.NEXT_PUBLIC_SCANNER_ENABLED !== "true",
    "Scanner is not enabled for this deployment",
  );
  await context.addCookies([
    {
      name: "next-auth.session-token",
      url: baseURL,
      value: await encode({
        token: { email: "smoke@example.test", sub: "smoke@example.test" },
        secret: process.env.NEXTAUTH_SECRET,
        maxAge: 3600,
      }),
    },
  ]);
  let releaseProviders;
  let releaseHistory;
  let releaseUpload;
  const providersReady = new Promise((resolve) => {
    releaseProviders = resolve;
  });
  const historyReady = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  const uploadReady = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/proxy/scanner/jobs/engines", async (route) => {
    await providersReady;
    await route.fulfill({
      json: { items: [{ id: "ots-homr", displayName: "OTS-HOMR" }] },
    });
  });
  await page.route("**/api/proxy/scanner/jobs?limit=20", async (route) => {
    await historyReady;
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/proxy/scanner/jobs", async (route) => {
    await uploadReady;
    await route.fulfill({
      status: 500,
      json: { message: "Test upload stopped" },
    });
  });
  try {
    await page.goto("/scanner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Loading recognition providers…"),
    ).toBeVisible();
    await expect(page.getByLabel("Provider", { exact: true })).toBeDisabled();
    await page.getByLabel("Score files").setInputFiles({
      name: "page.png",
      mimeType: "image/png",
      buffer: Buffer.from("test upload"),
    });
    releaseProviders();
    await expect(page.getByLabel("Provider", { exact: true })).toBeEnabled();
    await page.getByLabel("Provider", { exact: true }).selectOption("ots-homr");
    await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select pages" }).click();
    await expect(page.getByRole("status")).toContainText(
      /Uploading to OurTextScores|Upload complete/,
    );
    await expect(
      page.getByRole("status").locator(".animate-spin"),
    ).toBeVisible();
    await expect(page.getByLabel("Provider", { exact: true })).toBeDisabled();
    releaseUpload();
    await expect(
      page.getByRole("alert").filter({ hasText: "Test upload stopped" }),
    ).toBeVisible();
    await expect(page.getByLabel("Provider", { exact: true })).toBeEnabled();
  } finally {
    releaseProviders();
    releaseHistory();
    releaseUpload();
  }
});
