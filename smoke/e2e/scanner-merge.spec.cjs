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
    for (const message of await listMessages(request)) {
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
  throw new Error("Scanner merge sign-in link was not received");
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.describe("Scanner page assembly", () => {
  test.skip(
    process.env.SCANNER_MERGE !== "1",
    "Run with the scanner merge Compose override",
  );

  test("combines a three-page job and keeps the per-page results intact", async ({
    page,
    request,
  }) => {
    const email = `scanner_merge_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);

    await page.locator("#scanner-file").setInputFiles(
      [1, 2, 3].map((index) => ({
        name: `merge-page-${index}.png`,
        mimeType: "image/png",
        buffer: PNG,
      })),
    );
    await page.getByRole("button", { name: "Upload and review" }).click();
    await page.getByRole("link", { name: /merge-page-1\.png/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review pages before scanning" }),
    ).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Start scanning" }).click();

    await expect(
      page.getByRole("link", { name: "Download all results (.zip)" }),
    ).toBeVisible({ timeout: 180_000 });

    // The combined score is offered only after assembly and validation passed.
    const combinedLink = page.getByRole("link", {
      name: "Download combined MusicXML",
    });
    await expect(combinedLink).toBeVisible();
    await expect(page.getByText(/Page assembly is in beta/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open combined score in Score Editor" }),
    ).toBeVisible();

    const combined = await page.evaluate(async () => {
      const link = [...document.querySelectorAll("a")].find((candidate) =>
        candidate.textContent?.includes("Download combined MusicXML"),
      );
      if (!(link instanceof HTMLAnchorElement))
        return { status: 0, body: "", disposition: "" };
      const response = await fetch(link.href);
      return {
        status: response.status,
        body: await response.text(),
        disposition: response.headers.get("content-disposition") || "",
      };
    });
    expect(combined.status).toBe(200);
    expect(combined.disposition).toContain("scan-combined.musicxml");
    expect(combined.body).toContain("<score-partwise");
    // Three pages of one measure each, renumbered continuously, with a page
    // break at each appended boundary but not before the first page.
    expect(combined.body).toContain('<measure number="3"');
    expect((combined.body.match(/new-page="yes"/g) || []).length).toBe(2);

    const archive = await page.evaluate(async () => {
      const link = [...document.querySelectorAll("a")].find((candidate) =>
        candidate.textContent?.includes("Download all results"),
      );
      if (!(link instanceof HTMLAnchorElement)) return { status: 0, body: "" };
      const response = await fetch(link.href);
      return {
        status: response.status,
        body: new TextDecoder("latin1").decode(await response.arrayBuffer()),
      };
    });
    expect(archive.status).toBe(200);
    // Assembly is additive: per-page files remain in the ZIP alongside it.
    expect(archive.body).toContain("combined.musicxml");
    expect(archive.body).toContain("combined.pdf");
    expect(archive.body).toContain("page-001.musicxml");
    expect(archive.body).toContain("page-003.musicxml");
    expect(archive.body).toContain("scanner-manifest.json");
  });
});
