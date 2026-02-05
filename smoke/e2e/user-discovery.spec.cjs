// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

async function listMessages(request) {
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

async function signInViaEmail(page, request, email) {
  await page.goto(`${BASE_URL}/api/auth/signin`);
  const input = page.locator('input[type="email"][name="email"]');
  if (!(await input.count())) {
    const button = page.locator('button:has-text("Email"), a:has-text("Email")');
    if (await button.count()) await button.first().click();
  }
  await expect(page.locator('input[type="email"][name="email"]')).toBeVisible({ timeout: 5000 });
  await input.fill(email);
  const submit = page.locator('button:has-text("Sign in with Email"), button:has-text("Send magic link"), button:has-text("Sign in")');
  if (await submit.count()) await submit.first().click(); else await input.press('Enter');

  const magicUrl = await findMagicLinkFor(request, email);
  await page.goto(magicUrl);
  await page.goto(BASE_URL);
}

test.describe('User profile discovery', () => {
  test('user page via revision badge lists uploads', async ({ page, request }) => {
    const email = `userdiscovery_${Date.now()}@example.test`;
    const username = `smokeuser${Date.now().toString().slice(-6)}`;

    // Sign in and set username
    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 });

    const usernameInput = page.locator('input[name="username"]');
    await expect(usernameInput).toBeVisible();
    await usernameInput.fill(username);

    const saveButton = page.locator('form[data-testid="profile-form"] button:has-text("Save")');
    await saveButton.click();
    await expect(page.locator('text=Profile updated successfully!')).toBeVisible({ timeout: 10000 });

    // Pick a work
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works[0];
    expect(work).toBeTruthy();

    // Create JWT for same email used for sign-in, so uploads are attributed to this user
    const { createHmac } = require('crypto');
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const makeJwt = (sub, mail, sec) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(Buffer.from(JSON.stringify({ sub, email: mail, iat: now, exp: now + 3600 })));
      const data = `${header}.${payload}`;
      const sig = b64url(createHmac('sha256', sec).update(data).digest());
      return `${data}.${sig}`;
    };
    const token = makeJwt(email, email, secret);

    // Upload a new source for this work as this user
    const fs = require('fs');
    const path = require('path');
    const mxlPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mxl');
    const buffer = fs.readFileSync(mxlPath);
    const label = `UserDiscovery ${Date.now()}`;

    const multipart = {
      label,
      commitMessage: 'user discovery smoke',
      file: { name: 'bach_orig.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer }
    };

    const up = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources`, {
      multipart,
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(up.ok()).toBeTruthy();
    const upJson = await up.json();
    const sourceId = upJson.sourceId;
    expect(sourceId).toBeTruthy();

    // Open work detail and locate the new source card
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);
    const card = page.locator('article', { hasText: label }).first();
    await expect(card).toBeVisible({ timeout: 20000 });

    // Click the uploader badge in the source header
    const userBadgeLink = card.locator(`a:has-text("${username}")`).first();
    await expect(userBadgeLink).toBeVisible({ timeout: 15000 });

    await Promise.all([
      page.waitForURL(new RegExp(`/users/${username.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`)),
      userBadgeLink.click()
    ]);

    // Verify user profile page
    await expect(page.locator(`h1:has-text("${username}")`)).toBeVisible({ timeout: 10000 });

    // The contributed source should appear in the user's list
    const sourceItem = page.locator(`li:has-text("${label}")`).first();
    await expect(sourceItem).toBeVisible({ timeout: 15000 });

    // Click contribution link and ensure source opens on work page
    const contributionLink = sourceItem.locator(`a[href*="/works/${work.workId}"]`).first();
    await contributionLink.click();
    await expect(page).toHaveURL(new RegExp(`/works/${work.workId}\\?source=${sourceId}`));
    const openedCard = page.locator(`#source-${sourceId}`);
    await expect(openedCard).toBeVisible({ timeout: 15000 });
    await expect(openedCard.locator('text=Original filename')).toBeVisible({ timeout: 15000 });
  });
});
