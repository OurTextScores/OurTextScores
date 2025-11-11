// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

async function listMessages(request) {
  // Try Mailpit v1 API first, then fallback
  const v1 = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
  if (v1.ok()) {
    const data = await v1.json();
    return Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
  }
  const legacy = await request.get(`${MAILPIT}/api/msgs`);
  if (legacy.ok()) return await legacy.json();
  return [];
}

async function findMagicLinkFor(request, toEmail, subjectIncludes = 'Sign in to OurTextScores', timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = await listMessages(request);
    for (const m of msgs) {
      const toList = (m.To || m.to || []).map((t) => (typeof t === 'string' ? t : t.Address || t.address)).filter(Boolean);
      const subj = m.Subject || m.subject || '';
      if (toList.find((t) => String(t).toLowerCase().includes(toEmail.toLowerCase())) && String(subj).includes(subjectIncludes)) {
        const id = m.ID || m.Id || m.id || m.MessageID || m.messageId;
        if (!id) continue;
        const msgResp = await request.get(`${MAILPIT}/api/v1/message/${id}`);
        if (msgResp.ok()) {
          const data = await msgResp.json();
          const html = data?.HTML || '';
          const text = data?.Text || '';
          let match = html.match(/href=\"(http[^\"]+\/api\/auth\/callback\/email[^\"]*)\"/i);
          if (match && match[1]) return match[1];
          match = text.match(/(http[^\s]+\/api\/auth\/callback\/email[^\s]*)/i);
          if (match && match[1]) return match[1];
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Magic link not found in Mailpit');
}

test.describe('Email auth (magic link)', () => {
  test('sign in via email and see session UI', async ({ page, request }) => {
    const email = process.env.SMOKE_EMAIL || 'smoke@example.test';

    // Go to NextAuth sign-in
    await page.goto(`${BASE_URL}/api/auth/signin`);
    // Ensure email form is visible
    const input = page.locator('input[type="email"][name="email"]');
    if (!(await input.count())) {
      const button = page.locator('button:has-text("Email"), a:has-text("Email")');
      if (await button.count()) await button.first().click();
    }

    // Fill email input and submit
    await expect(page.locator('input[type="email"][name="email"]')).toBeVisible({ timeout: 5000 });
    await input.fill(email);
    // NextAuth labels vary; click submit or press Enter
    const submit = page.locator('button:has-text("Sign in with Email"), button:has-text("Send magic link"), button:has-text("Sign in")');
    if (await submit.count()) await submit.first().click(); else await input.press('Enter');

    // Poll Mailpit for the magic link
    const magicUrl = await findMagicLinkFor(request, email);
    expect(magicUrl).toContain('/api/auth/callback/email');

    // Complete sign-in and go to home to assert header session state
    await page.goto(magicUrl);
    await page.goto(BASE_URL);
    // Approvals page should be accessible with a session
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.locator('text=Approvals Inbox')).toBeVisible({ timeout: 15000 });
  });
});
