// @ts-check
const { test, expect } = require("@playwright/test");
const { encode } = require("../../frontend/node_modules/next-auth/jwt");
const { XMLParser } = require("../../backend/node_modules/fast-xml-parser");

/**
 * Checkbox -> review (text, lyric line and note decisions per row) -> lyrics saved into the scan's score,
 * through the real browser, proxy and backend.
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
// What a review adds: lyrics, and the directions/dynamics it writes (marked with an ots-review id).
const isReviewDirection = (n) =>
  "direction" in n && String(n[":@"]?.["@_id"] ?? "").startsWith("ots-review-");
const strip = (nodes) =>
  nodes
    .filter((n) => !("lyric" in n) && !isReviewDirection(n))
    .map((n) =>
      Object.fromEntries(
        Object.entries(n).map(([k, v]) => [k, Array.isArray(v) ? strip(v) : v]),
      ),
    );
const lyricCount = (xml) => (xml.match(/<lyric[ >]/g) || []).length;
const reviewDirectionCount = (xml) => (xml.match(/<direction [^>]*id="ots-review-/g) || []).length;

test("ticking the lyrics box leads to lyrics added to the scan's score, and nothing else changed", async ({
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
      .getByRole("link", { name: /Review lyrics and staff text for this page/ })
      .click({ timeout: 600000 });
  } else {
    await page.goto(`/scanner/${jobId}/pages/1/lyric-review`);
  }

  await expect(page.locator("article").first()).toBeVisible({ timeout: 180000 });
  // Every card shows a text box under each recognised note (the proposal filled in, blanks elsewhere) and a lyric line.
  await expect(page.getByLabel(/^Text for note 1 of /).first()).toBeVisible();
  // The score as it stands before this save (a re-run starts from a score a previous save already carries).
  const before = await (
    await page.request.get(`/api/proxy/scanner/jobs/${jobId}/artifacts/musicxml?page=1`)
  ).text();
  await page.getByRole("button", { name: "Accept all suggested rows" }).click();
  const open = page.getByRole("button", { name: "Add accepted lyrics and staff text to the score" });
  await expect(open).toBeEnabled({ timeout: 90000 }); // waits for the recognised note choices
  await open.click();
  const save = page.getByRole("button", { name: "Add to the score" });
  await expect(save).toBeEnabled(); // the list of what will be written is the review; no extra checkbox
  // Two lists in the confirmation: the lyric syllables, and (aria-labelled) the directions and dynamics.
  const listed = await page.locator("ol.list-decimal:not([aria-label]) li").count();
  const acceptedStaffText = await page.locator('ol[aria-label="Directions to add"] li').count();
  expect(listed).toBeGreaterThan(0);
  expect(acceptedStaffText).toBeGreaterThan(0);
  await save.click();
  await expect(page.getByText(new RegExp(`Added ${listed} lyric syllables`))).toBeVisible({
    timeout: 60000,
  });
  await page.getByRole("link", { name: "View the score" }).click();
  await page.waitForURL(new RegExp(`/scanner/${jobId}$`));

  // The scan's score (job level) now carries the lyrics and staff text; so does the engine's download, which serves
  // the reviewed copy (a save must show up in every download of the page).
  const recognised = await (
    await page.request.get(`/api/proxy/scanner/jobs/${jobId}/artifacts/musicxml?page=1&engine=ots-homr`)
  ).text();
  const scanScore = await (
    await page.request.get(`/api/proxy/scanner/jobs/${jobId}/artifacts/musicxml?page=1`)
  ).text();
  expect(lyricCount(scanScore)).toBe(listed);
  expect(lyricCount(recognised)).toBe(listed);
  // Accept all also took the directions and dynamics that had a proposed note, and the save wrote them.
  expect(reviewDirectionCount(scanScore)).toBe(acceptedStaffText);
  expect(reviewDirectionCount(recognised)).toBe(acceptedStaffText);
  // The only difference from the score before the save is what a review adds (saving again replaces, not stacks).
  expect(JSON.stringify(strip(parser().parse(scanScore)))).toBe(
    JSON.stringify(strip(parser().parse(before))),
  );
});
