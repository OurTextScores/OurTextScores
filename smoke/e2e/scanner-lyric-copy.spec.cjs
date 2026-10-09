// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");

/** Read-only local regression: reuses an existing completed page, never starts a scanner/provider. */
test("reviewed syllable downloads a new score copy through the authenticated proxy", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(300000);
  test.skip(
    process.env.LYRIC_COPY_SMOKE !== "1",
    "Opt in with a completed local fixture job",
  );
  const jobId = process.env.LYRIC_COPY_JOB_ID;
  const pageNumber = Number(process.env.LYRIC_COPY_PAGE || "1");
  const email = process.env.LYRIC_COPY_OWNER_EMAIL;
  expect(jobId && email && process.env.NEXTAUTH_SECRET).toBeTruthy();
  const token = await encode({
    token: { email, sub: email, name: "Local lyric copy smoke" },
    secret: process.env.NEXTAUTH_SECRET,
    maxAge: 3600,
  });
  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      url: process.env.BASE_URL || "http://localhost:3000",
    },
  ]);
  const base = `/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/lyric-candidates`;
  await page.goto(`/scanner/${jobId}/pages/${pageNumber}/lyric-review`);
  await expect(
    page.getByRole("heading", { name: `Lyric review — page ${pageNumber}` }),
  ).toBeVisible();
  const inventoryResponse = await page.request.get(`${base}/notes`);
  expect(inventoryResponse.ok()).toBeTruthy();
  const before = await inventoryResponse.json();
  const note = before.notes.find((n) => !n.occupiedLines.includes("20"));
  expect(note).toBeTruthy();
  const article = page.locator("article").first();
  await expect(article).toBeVisible();
  await article.getByRole("textbox").fill("local smoke syllable");
  await article.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "Add reviewed syllable" }).click();
  await page.getByLabel("Correct syllable", { exact: true }).fill("fi");
  await page
    .getByLabel("Recognised note", { exact: true })
    .selectOption(note.id);
  await page.getByLabel("Printed lyric line", { exact: true }).fill("20");
  const downloadButton = page.getByRole("button", {
    name: "Download corrected score copy",
  });
  await expect(downloadButton).toBeDisabled();
  for (const label of [
    "Syllable text confirmed",
    "Printed line confirmed",
    "Note placement confirmed",
  ])
    await page.getByLabel(label, { exact: true }).check();
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const output = Buffer.concat(chunks).toString("utf8");
  expect(output).toContain('<lyric number="20"><text>fi</text></lyric>');
  const afterResponse = await page.request.get(`${base}/notes`);
  expect((await afterResponse.json()).musicXmlSha256).toBe(
    before.musicXmlSha256,
  );
  const scan = await page.request.get(`${base}/scan`);
  expect(scan.ok()).toBeTruthy();
  expect(scan.headers()["content-type"]).toContain("image/png");
  const unauthenticated = await request.get(
    `${process.env.PUBLIC_API || "http://localhost:4000/api"}/scanner/jobs/${jobId}/pages/${pageNumber}/lyric-candidates/notes`,
  );
  expect(unauthenticated.status()).toBe(401);
});
