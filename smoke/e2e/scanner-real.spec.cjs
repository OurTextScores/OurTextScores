// @ts-check
const { readFileSync } = require("node:fs");
const { extname } = require("node:path");
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";
const FIXTURE = process.env.HOMR_REAL_FIXTURE || "";

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
  throw new Error("Scanner real-HOMR sign-in link was not received");
}

test.describe("Scanner real HOMR CPU provider", () => {
  test.skip(
    process.env.SCANNER_REAL !== "1" || !FIXTURE,
    "Set SCANNER_REAL=1 and HOMR_REAL_FIXTURE",
  );

  test("completes the authenticated browser workflow with pinned CPU provenance", async ({
    page,
    request,
  }) => {
    test.setTimeout(35 * 60 * 1_000);
    const extension = extname(FIXTURE).toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : "image/jpeg";
    const email = `scanner_real_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    await page.locator("#scanner-file").setInputFiles({
      name: `homr-real${extension}`,
      mimeType,
      buffer: readFileSync(FIXTURE),
    });
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /homr-real/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole("button", { name: "Start scanning" }).click();
    await expect(
      page.getByRole("link", { name: "Download all results (.zip)" }),
    ).toBeVisible({
      timeout: 30 * 60 * 1_000,
    });

    const result = await page.evaluate(async () => {
      const response = await fetch(
        window.location.pathname.replace(
          "/scanner/",
          "/api/proxy/scanner/jobs/",
        ),
      );
      return response.json();
    });
    expect(result.status).toBe("succeeded");
    expect(result.providerRevision).toBe("ots-homr-cpu-v1");
    expect(result.modelRevision).toBe(
      "1ddc6fcc26c4baa746eaffbba7f5e01429063465",
    );
    await expect(page.locator('object[type="application/pdf"]')).toBeVisible();
  });
});
