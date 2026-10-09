// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");
const { XMLParser } = require("../../backend/node_modules/fast-xml-parser");

/**
 * Checkbox -> review -> corrected score, through the real browser, proxy and backend.
 *
 * Opt in with LYRIC_FLOW_SMOKE=1, LYRIC_FLOW_OWNER_EMAIL and either
 *   LYRIC_FLOW_IMAGE   a page image: uploads it with "This score has lyrics" ticked, starts the scan (needs a
 *                      provider that runs fusion-v1 + OCR: costs a GPU scan) and waits for it, or
 *   LYRIC_FLOW_JOB_ID  an already completed local job, to re-run the review half without a provider.
 * Needs the local stack with NEXT_PUBLIC_OTS_HOMR_FUSION_ENABLED=1, both lyric-review flags and
 * SCANNER_OTS_HOMR_FUSION_ENABLED=1. Reviewer confirmations are clicked by the test: they are a fixture,
 * not a person's approval. It checks the copy is a NEW document whose only difference is added lyrics.
 */
const parser = () =>
  new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false });
const strip = (nodes) =>
  nodes
    .filter((n) => !("lyric" in n))
    .map((n) =>
      Object.fromEntries(
        Object.entries(n).map(([k, v]) => [k, Array.isArray(v) ? strip(v) : v]),
      ),
    );
const lyricCount = (xml) => (xml.match(/<lyric[ >]/g) || []).length;

test("ticking the lyrics box leads to a reviewed score copy with only lyrics added", async ({
  page,
  context,
}) => {
  test.setTimeout(900000);
  test.skip(process.env.LYRIC_FLOW_SMOKE !== "1", "Opt in; see the file header");
  const email = process.env.LYRIC_FLOW_OWNER_EMAIL;
  expect(email && process.env.NEXTAUTH_SECRET).toBeTruthy();
  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: await encode({
        token: { email, sub: email, name: "Local lyric flow smoke" },
        secret: process.env.NEXTAUTH_SECRET,
        maxAge: 7200,
      }),
      url: process.env.BASE_URL || "http://localhost:3000",
    },
  ]);

  let jobId = process.env.LYRIC_FLOW_JOB_ID;
  if (!jobId) {
    expect(process.env.LYRIC_FLOW_IMAGE).toBeTruthy();
    await page.goto("/scanner");
    await page.setInputFiles("#scanner-file", process.env.LYRIC_FLOW_IMAGE);
    await expect(
      page.locator("select[aria-label=Provider] option", { hasText: "OTS-HOMR" }),
    ).toHaveCount(1, { timeout: 180000 });
    await page.getByLabel("Provider", { exact: true }).selectOption({ label: "OTS-HOMR" });
    await page.getByLabel("This score has lyrics").check();
    await page.getByRole("button", { name: "Select pages" }).click();
    await page.waitForURL(/\/scanner\/[0-9a-f-]{36}/, { timeout: 120000 });
    jobId = page.url().match(/scanner\/([0-9a-f-]{36})/)[1];
    await page.getByRole("button", { name: /Start scanning/ }).click();
    await page
      .getByRole("link", { name: /Review lyrics for this page/ })
      .click({ timeout: 600000 });
  } else {
    await page.goto(`/scanner/${jobId}/pages/1/lyric-review`);
  }

  await expect(page.locator("article").first()).toBeVisible({ timeout: 180000 });
  const articles = page.locator("article");
  for (let i = 0; i < (await articles.count()); i += 1) {
    const article = articles.nth(i);
    if (/Suggested lyric/.test((await article.locator("p").first().textContent()) || ""))
      await article.getByRole("button", { name: "Accept", exact: true }).click();
  }
  const add = page.getByRole("button", { name: /Add \d+ proposed syllables/ });
  await expect(add).toBeEnabled({ timeout: 90000 }); // waits for the recognised note choices
  await add.click();
  const forms = page.locator("fieldset");
  const count = await forms.count();
  expect(count).toBeGreaterThan(0);
  const download = page.getByRole("button", { name: "Download corrected score copy" });
  await expect(download).toBeDisabled(); // proposals arrive unconfirmed
  for (let i = 0; i < count; i += 1)
    for (const label of [
      "Syllable text confirmed",
      "Printed line confirmed",
      "Note placement confirmed",
    ])
      await forms.nth(i).getByLabel(label).check();
  const downloaded = page.waitForEvent("download");
  await download.click();
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const copy = Buffer.concat(chunks).toString("utf8");

  const originalResponse = await page.request.get(
    `/api/proxy/scanner/jobs/${jobId}/artifacts/musicxml?page=1&engine=ots-homr`,
  );
  expect(originalResponse.ok()).toBeTruthy();
  const original = await originalResponse.text();
  expect(lyricCount(original)).toBe(0);
  expect(lyricCount(copy)).toBe(count);
  expect(JSON.stringify(strip(parser().parse(copy)))).toBe(
    JSON.stringify(strip(parser().parse(original))),
  );
});
