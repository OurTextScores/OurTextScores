// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");

test("offers a retry beside a failed provider while retaining the successful reading", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    process.env.SCANNER_ENABLED !== "true" &&
      process.env.NEXT_PUBLIC_SCANNER_ENABLED !== "true",
    "Scanner is disabled",
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
  const capabilities = (name) => ({
    displayName: name,
    outputArtifactKinds: ["musicxml", "pdf"],
    supportsSpotReview: true,
    supportsMeasureGeometry: true,
    unsupportedSemanticClasses: [],
  });
  const job = {
    jobId: "provider-retry-check",
    status: "succeeded",
    originalFilename: "Provider retry fixture",
    pageCount: 1,
    includedPageCount: 1,
    hasMusicXml: true,
    hasPdf: true,
    hasThumbnail: false,
    hasZip: false,
    canRetry: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enginePlan: {
      version: "scanner-engine-plan-v1",
      engineIds: ["homr", "ots-homr"],
      primaryEngineId: "homr",
      fallbackEngineIds: ["ots-homr"],
      capabilitySnapshots: {
        homr: capabilities("HOMR"),
        "ots-homr": capabilities("OTS-HOMR"),
      },
    },
    pages: [
      {
        pageNumber: 1,
        ordinal: 1,
        included: true,
        rotationDegrees: 0,
        status: "succeeded",
        attempts: 1,
        canRetry: true,
        hasMusicXml: true,
        hasPdf: true,
        hasThumbnail: false,
        engines: {
          homr: {
            status: "succeeded",
            attempts: 1,
            hasMusicXml: true,
            hasPdf: true,
          },
          "ots-homr": {
            status: "failed",
            attempts: 2,
            errorMessage: "Scanner provider is unavailable",
            hasMusicXml: false,
            hasPdf: false,
          },
        },
      },
    ],
  };
  const root = "**/api/proxy/scanner/jobs/provider-retry-check";
  await page.route(root, (route) => route.fulfill({ json: job }));
  let releaseRetry;
  const retryResponse = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  await page.route(root + "/pages/1/retry", async (route) => {
    await retryResponse;
    job.status = "queued";
    await route.fulfill({ json: job });
  });
  try {
    await page.goto("/scanner/provider-retry-check");
    const retry = page.getByRole("button", {
      name: "Retry OTS-HOMR",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry HOMR", exact: true }),
    ).toHaveCount(0);
    const request = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/pages/1/retry"),
    );
    await retry.click();
    await request;
    await expect(
      page.getByRole("button", { name: "Queuing…", exact: true }),
    ).toBeDisabled();
    releaseRetry();
    await expect(retry).toHaveCount(0);
    await expect(
      page
        .locator('a[href*="/artifacts/musicxml?"][href*="engine=homr"]')
        .first(),
    ).toBeVisible();
  } finally {
    releaseRetry();
  }
});
