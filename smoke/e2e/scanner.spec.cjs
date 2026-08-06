// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

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
  await input.press('Enter');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const messages = await listMessages(request);
    for (const message of messages) {
      const recipients = (message.To || []).map((value) => value.Address || value.address || value);
      if (!recipients.some((value) => String(value).toLowerCase().includes(email.toLowerCase()))) continue;
      const id = message.ID || message.Id || message.id;
      const detail = await request.get(`${MAILPIT}/api/v1/message/${id}`);
      if (!detail.ok()) continue;
      const data = await detail.json();
      const combined = `${data.HTML || ''}\n${data.Text || ''}`;
      const match = combined.match(/https?:[^\s"<]+\/api\/auth\/callback\/email[^\s"<]*/i);
      if (match) {
        await page.goto(match[0].replace(/&amp;/g, '&'));
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Scanner smoke sign-in link was not received');
}

test.describe('Scanner pilot', () => {
  test.skip(process.env.SCANNER_SMOKE !== '1', 'Run with the scanner smoke Compose override');

  test('uploads an image and returns MusicXML, PDF, and one terminal notification', async ({ page, request }) => {
    const email = `scanner_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/scanner`);
    await expect(page.getByRole('heading', { name: 'Scanner', exact: true })).toBeVisible();

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    await page.locator('#scanner-file').setInputFiles({
      name: 'scanner-smoke.png',
      mimeType: 'image/png',
      buffer: png
    });
    await page.getByRole('button', { name: 'Start scan' }).click();
    await page.getByRole('link', { name: /scanner-smoke\.png/ }).click();

    await expect(page.getByRole('link', { name: 'Download MusicXML' })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Rendered score' })).toBeVisible({ timeout: 120_000 });

    const artifactStatus = await page.evaluate(async () => {
      const link = document.querySelector('a[download]');
      if (!(link instanceof HTMLAnchorElement)) return 0;
      return (await fetch(link.href)).status;
    });
    expect(artifactStatus).toBe(200);

    await page.goto(`${BASE_URL}/notifications`);
    await expect(page.getByText('Scan complete', { exact: true })).toHaveCount(1);
  });
});
