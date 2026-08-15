// @ts-check
const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";
const JOB_ID = process.env.SCANNER_COMPARATOR_JOB_ID || "";
const OWNER_EMAIL = process.env.SCANNER_COMPARATOR_OWNER_EMAIL || "";

async function listMessages(request) {
  const response = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
  if (!response.ok()) return [];
  const data = await response.json();
  return Array.isArray(data?.messages) ? data.messages : [];
}

async function signInViaEmail(page, request, email) {
  // This smoke deliberately signs in an existing retained-job owner. Unlike
  // the upload smoke's unique address, that mailbox can contain old magic
  // links, so only a message created by this request is eligible.
  const existingIds = new Set(
    (await listMessages(request)).map((message) =>
      String(message.ID || message.Id || message.id || ""),
    ),
  );
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
      ) {
        continue;
      }
      const id = message.ID || message.Id || message.id;
      if (existingIds.has(String(id))) continue;
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
  throw new Error("Comparator smoke sign-in link was not received");
}

function fullTakeButtons(frame, direction) {
  return frame.locator(
    `button[data-testid^="btn-take-${direction}-"]:not([data-testid*="-dynamics-"]):not([data-testid*="-lyrics-"])`,
  );
}

async function dispatchTakeAndWait(page, button) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().includes("/merged/decisions"),
      { timeout: 120_000 },
    ),
    button.dispatchEvent("click"),
  ]);
  const body = await response.json();
  expect(response.ok(), String(body?.message || response.status())).toBe(true);
  return body;
}

test.describe("Scanner comparator", () => {
  test.skip(
    process.env.SCANNER_COMPARATOR_SMOKE !== "1" || !JOB_ID || !OWNER_EMAIL,
    "Run through npm run smoke:scanner:comparator against a retained dual-engine job",
  );

  test("grounds hover evidence and performs a reversible real Take", async ({
    page,
    request,
  }) => {
    // Three initial engravings plus two server-side MuseScore normalizations
    // and two replacement engravings are intentionally much heavier than an
    // ordinary page smoke. Individual waits remain bounded below.
    test.setTimeout(300_000);
    await signInViaEmail(page, request, OWNER_EMAIL);
    await page.goto(`${BASE_URL}/scanner/${JOB_ID}/pages/1/compare`);

    const editor = page.frameLocator(
      'iframe[title^="Reconciling difference"], iframe[title^="Reviewing page"]',
    );
    const downButtons = fullTakeButtons(editor, "down");
    await expect(downButtons.first()).toBeVisible({ timeout: 120_000 });

    await expect(editor.getByTestId("difference-description")).toHaveCount(0);
    await expect(editor.getByTestId("scan-difference-box")).toHaveCount(0);

    const first = downButtons.first();
    const firstTestId = await first.getAttribute("data-testid");
    const blockIndex = String(firstTestId).replace("btn-take-down-", "");
    // The host deliberately grows this iframe to the complete comparator
    // document. Chromium can render an element below the outer viewport while
    // Playwright's nested-frame scrolling still calls it "outside"; dispatch
    // the same pointer transition React receives instead of testing scrolling.
    await first.dispatchEvent("mouseover");

    const descriptions = editor.getByTestId("difference-description");
    await expect(descriptions).toHaveCount(2);
    await expect(descriptions.first()).not.toBeEmpty();
    const boxes = editor.getByTestId("scan-difference-box");
    await expect(boxes.first()).toHaveAttribute("data-block-index", blockIndex);

    // Moving away does not clear the evidence; a different Take is the only
    // action that replaces the conflict under inspection.
    await editor.locator("body").dispatchEvent("mousemove");
    await expect(descriptions).toHaveCount(2);
    await expect(boxes.first()).toHaveAttribute("data-block-index", blockIndex);

    const testIds = await downButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-testid") || ""),
    );
    const replacementId = testIds.find(
      (testId) => testId && testId !== firstTestId,
    );
    if (replacementId) {
      const replacement = editor.getByTestId(replacementId);
      const replacementBlock = replacementId.replace("btn-take-down-", "");
      await replacement.dispatchEvent("mouseover");
      await expect(boxes.first()).toHaveAttribute(
        "data-block-index",
        replacementBlock,
      );
    }

    const down = editor.getByTestId(`btn-take-down-${blockIndex}`);
    const up = editor.getByTestId(`btn-take-up-${blockIndex}`);
    const downInitiallyDisabled = await down.isDisabled();
    const take = downInitiallyDisabled ? up : down;
    const restore = downInitiallyDisabled ? down : up;

    const taken = await dispatchTakeAndWait(page, take);
    await expect(editor.getByTestId("merged-status")).toContainText(
      `Saved, revision ${taken.revision}`,
      { timeout: 120_000 },
    );
    await expect(editor.getByTestId("take-outcome")).toContainText("Taken.", {
      timeout: 120_000,
    });
    await expect(restore).toBeEnabled({ timeout: 120_000 });

    const restored = await dispatchTakeAndWait(page, restore);
    await expect(editor.getByTestId("merged-status")).toContainText(
      `Saved, revision ${restored.revision}`,
      { timeout: 120_000 },
    );
    await expect(editor.getByTestId("take-outcome")).toContainText("Taken.", {
      timeout: 120_000,
    });
    await expect(take).toBeEnabled({ timeout: 120_000 });
  });
});
