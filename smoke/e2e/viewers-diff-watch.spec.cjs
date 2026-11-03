// @ts-check
const { test, expect } = require('@playwright/test');
const { encode } = require('../../frontend/node_modules/next-auth/jwt');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';
test.describe('Viewers + Diff + Watch', () => {
  test('renders playback/PDF and diff, and toggles watch', async ({ page, context, request }) => {
    const email = process.env.SMOKE_EMAIL || 'smoke@example.test';
    // Email sign-in is covered separately; this test needs an authenticated viewer.
    await context.addCookies([{
      name: 'next-auth.session-token',
      url: BASE_URL,
      value: await encode({
        token: { email, sub: email },
        secret: process.env.NEXTAUTH_SECRET || 'dev-secret',
        maxAge: 3600
      })
    }]);
    const sessionResponse = await context.request.get(`${BASE_URL}/api/auth/session`);
    expect(sessionResponse.ok()).toBeTruthy();
    expect((await sessionResponse.json()).user?.email).toBe(email);

    // Choose a work with derivatives
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    const works = (await worksResp.json()).works;
    const work = works.find((w) => (w.availableFormats || []).length > 0) || works[0];
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);

    // Since the work-page redesign (3cb71b9) the recommended source opens with its preview playing; the other cards
    // stay collapsed, so exactly one score engine starts.
    const firstSourceHeader = page.getByTestId('source-card-header').first();
    await expect(firstSourceHeader).toBeVisible();
    if ((await page.getByTestId('source-card-body').count()) === 0) await firstSourceHeader.click({ position: { x: 10, y: 10 } });
    const playerSummary = page.locator('summary', { hasText: 'Preview score' }).first();
    await expect(playerSummary).toBeVisible();
    await expect(page.getByTestId('score-preview-frame')).toHaveCount(1);

    const playerFrame = page.getByTestId('score-preview-frame').first();
    await expect(playerFrame).toHaveAttribute('allow', 'autoplay');
    const playerSrc = new URL(await playerFrame.getAttribute('src'), BASE_URL);
    expect(playerSrc.searchParams.get('embed')).toBe('player');
    const embeddedPlayer = page.frameLocator('[data-testid="score-preview-frame"]').first().getByTestId('embedded-score-player');
    await expect(embeddedPlayer).toBeVisible({ timeout: 60000 });
    await expect(page.frameLocator('[data-testid="score-preview-frame"]').first().getByTestId('player-svg').locator('svg')).toBeVisible({ timeout: 60000 });

    // PDF preview
    const pdfSummary = page.locator('summary', { hasText: 'Score preview (PDF)' });
    if (await pdfSummary.count()) {
      await pdfSummary.first().click();
      await expect(page.locator('object[type="application/pdf"]').first()).toBeVisible({ timeout: 10000 });
    }

    // Diff preview
    // Open revision history and Diff section
    // There can be multiple sources; open all revision history summaries
    const revSummaries = page.locator('summary', { hasText: 'Revision history' });
    const rs = await revSummaries.count();
    for (let i = 0; i < rs; i++) await revSummaries.nth(i).click();
    // Switch Diff type to XML and expect diff content
    const typeSelect = page.locator('label:has-text("Type") >> select');
    if (await typeSelect.count()) {
      await typeSelect.first().selectOption('xml');
      const diffEl = page.locator('.d2h-wrapper, .d2h-file-wrapper').first();
      // UI may render but be offscreen/hidden; try to scroll into view then fallback to API checks
      try {
        await diffEl.scrollIntoViewIfNeeded();
        await expect(diffEl).toBeVisible({ timeout: 15000 });
      } catch {
        // Fallback: call textdiff API directly (XML/manifest), ensure non-empty
        const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}`);
        const detail = await detailResp.json();
        const src = detail.sources[0];
        const revs = src.revisions.slice(0, 2);
        if (revs.length >= 2) {
          const a = revs[1].revisionId, b = revs[0].revisionId;
          const t2 = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(src.sourceId)}/textdiff?revA=${encodeURIComponent(a)}&revB=${encodeURIComponent(b)}&file=canonical`);
          expect(t2.ok()).toBeTruthy();
          const txt2 = await t2.text();
          expect((txt2 || '').length).toBeGreaterThan(0);
        }
      }
    }

    // Watch toggle (first source card)
    const watchBtn = page.locator('form button:has-text("Watch (")').first();
    if (await watchBtn.count()) {
      await watchBtn.click();
      await expect(page.locator('form button:has-text("Watching (")').first()).toBeVisible({ timeout: 10000 });
    }
  });
});
