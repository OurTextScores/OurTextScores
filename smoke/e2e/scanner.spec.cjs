// @ts-check
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";

async function listMessages(request) {
  const response = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
  if (!response.ok()) return [];
  const data = await response.json();
  return Array.isArray(data?.messages) ? data.messages : [];
}

async function signInViaEmail(page, request, email) {
  await page.goto(`${BASE_URL}/api/auth/signin`);
  const input = page.locator('input[type="email"][name="email"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(email);
  await input.press("Enter");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const messages = await listMessages(request);
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
      const id = message.ID || message.Id || message.id;
      const detail = await request.get(`${MAILPIT}/api/v1/message/${id}`);
      if (!detail.ok()) continue;
      const data = await detail.json();
      const combined = `${data.HTML || ""}\n${data.Text || ""}`;
      const match = combined.match(
        /https?:[^\s"<]+\/api\/auth\/callback\/email[^\s"<]*/i,
      );
      if (match) {
        await page.goto(match[0].replace(/&amp;/g, "&"));
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Scanner smoke sign-in link was not received");
}

function twoPagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources <<>> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources <<>> /Contents 6 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    "<< /Length 0 >>\nstream\n\nendstream",
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

test.describe("Scanner pilot", () => {
  test.skip(
    process.env.SCANNER_SMOKE !== "1",
    "Run with the scanner smoke Compose override",
  );

  test("uploads an image and returns page previews, downloads, and one terminal notification", async ({
    page,
    request,
  }) => {
    const email = `scanner_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    await expect(
      page.getByRole("heading", { name: "Scanner", exact: true }),
    ).toBeVisible();

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.locator("#scanner-file").setInputFiles({
      name: "scanner-smoke.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /scanner-smoke\.png/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Start scanning" }).click();

    await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      page.getByRole("link", { name: "Download all results (.zip)" }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('object[type="application/pdf"]')).toBeVisible();
    await expect(page.getByAltText("Source preview for page 1")).toBeVisible();

    const artifact = await page.evaluate(async () => {
      const link = [...document.querySelectorAll("a")].find((candidate) =>
        candidate.textContent?.includes("Download all results"),
      );
      if (!(link instanceof HTMLAnchorElement))
        return { status: 0, contents: "" };
      const response = await fetch(link.href);
      const contents = new TextDecoder("latin1").decode(
        await response.arrayBuffer(),
      );
      return { status: response.status, contents };
    });
    expect(artifact.status).toBe(200);
    expect(artifact.contents).toContain("scanner-manifest.json");
    expect(artifact.contents).toContain("page-001.musicxml");

    await page.goto(`${BASE_URL}/notifications`);
    await expect(page.getByText("Scan complete", { exact: true })).toHaveCount(
      1,
    );
  });

  test("keeps a two-page partial result and retries only the failed page", async ({
    page,
    request,
  }) => {
    const email = `scanner_pdf_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    await page.locator("#scanner-file").setInputFiles({
      name: "scanner-two-pages.pdf",
      mimeType: "application/pdf",
      buffer: twoPagePdf(),
    });
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /scanner-two-pages\.pdf/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({ timeout: 120_000 });
    await page
      .getByRole("button", { name: "Rotate source page 1 right" })
      .click();
    await page.getByRole("button", { name: "Start scanning" }).click();

    const pageTwo = page.getByRole("button", { name: /Page 2.*Failed/i });
    await expect(pageTwo).toBeVisible({ timeout: 120_000 });
    await pageTwo.click();
    await expect(
      page.getByText("Scanner test provider is temporarily unavailable"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry page" }).click();

    await expect(
      page.getByRole("button", { name: /Page 2.*Succeeded/i }),
    ).toBeVisible({ timeout: 120_000 });
    const attempts = await page.evaluate(async () => {
      const response = await fetch(
        window.location.pathname.replace(
          "/scanner/",
          "/api/proxy/scanner/jobs/",
        ),
      );
      const job = await response.json();
      return job.pages.map((item) => ({
        pageNumber: item.pageNumber,
        attempts: item.attempts,
        manualRetries: item.manualRetries,
      }));
    });
    expect(attempts).toEqual([
      { pageNumber: 1, attempts: 1, manualRetries: 0 },
      { pageNumber: 2, attempts: 1, manualRetries: 1 },
    ]);
    await expect(
      page.getByRole("link", { name: "Download all results (.zip)" }),
    ).toBeVisible();
    const zipContents = await page.evaluate(async () => {
      const response = await fetch(
        `${window.location.pathname.replace("/scanner/", "/api/proxy/scanner/jobs/")}/artifacts/zip`,
      );
      return new TextDecoder("latin1").decode(await response.arrayBuffer());
    });
    expect(zipContents).toContain("page-001.musicxml");
    expect(zipContents).toContain("page-002.musicxml");
  });

  test("natural-sorts multiple images and preserves review order through retry", async ({
    page,
    request,
  }) => {
    const email = `scanner_images_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.locator("#scanner-file").setInputFiles([
      { name: "page-10.png", mimeType: "image/png", buffer: png },
      { name: "page-2.png", mimeType: "image/png", buffer: png },
    ]);
    await expect(
      page.locator("li").filter({ hasText: "page-2.png" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /page-2\.png \+ 1 more/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({ timeout: 120_000 });
    await page
      .getByRole("button", { name: "Move source page 2 earlier" })
      .click();
    await page.getByRole("button", { name: "Start scanning" }).click();

    const failed = page.getByRole("button", {
      name: /Page 1.*Source 2.*Failed/i,
    });
    await expect(failed).toBeVisible({ timeout: 120_000 });
    await failed.click();
    await page.getByRole("button", { name: "Retry page" }).click();
    await expect(
      page.getByRole("button", { name: /Page 1.*Source 2.*Succeeded/i }),
    ).toBeVisible({ timeout: 120_000 });

    const result = await page.evaluate(async () => {
      const response = await fetch(
        window.location.pathname.replace(
          "/scanner/",
          "/api/proxy/scanner/jobs/",
        ),
      );
      return response.json();
    });
    expect(result.originalFilename).toBe("page-2.png + 1 more");
    expect(
      result.pages.map((item) => ({
        pageNumber: item.pageNumber,
        ordinal: item.ordinal,
        status: item.status,
      })),
    ).toEqual([
      { pageNumber: 2, ordinal: 1, status: "succeeded" },
      { pageNumber: 1, ordinal: 2, status: "succeeded" },
    ]);
  });
});
