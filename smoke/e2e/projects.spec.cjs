// @ts-check
const { test, expect } = require('@playwright/test');
const { createHmac } = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

function b64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(email) {
  const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub: email, email, iat: now, exp: now + 3600 })));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

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

test.describe('Projects flow', () => {
  test.setTimeout(180000);

  test('create project, edit row, create internal source, and open linked source', async ({ page, request }) => {
    const email = `projects_${Date.now()}@example.test`;
    await signInViaEmail(page, request, email);

    await page.goto(`${BASE_URL}/projects`);
    await expect(page.locator('h1:has-text("Projects")')).toBeVisible({ timeout: 15000 });

    const projectTitle = `Smoke Project ${Date.now()}`;
    await page.getByPlaceholder('Project title').fill(projectTitle);
    await page.getByPlaceholder('Description').fill('Smoke project description');
    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(/\/projects\/[^/]+$/);
    const projectUrl = new URL(page.url());
    const projectId = projectUrl.pathname.split('/').filter(Boolean).pop();
    expect(projectId).toBeTruthy();

    await page.getByRole('button', { name: 'Add Row' }).click();

    const externalInputs = page.locator('input[placeholder="https://..."]');
    await expect(externalInputs.first()).toBeVisible();
    await externalInputs.first().fill('https://example.com/scores/sample.xml');

    const imslpInputs = page.locator('input[placeholder="https://imslp.org/wiki/..."]');
    await imslpInputs.first().fill('https://imslp.org/wiki/Nocturne%2C_Op.9_No.2_(Chopin%2C_Fr%C3%A9d%C3%A9ric)');

    const notes = page.locator('textarea').first();
    await notes.fill('Needs manual verification');

    await page.getByRole('button', { name: 'Save' }).first().click();

    const token = makeJwt(email);
    const rowsResp = await request.get(`${PUBLIC_API}/projects/${encodeURIComponent(projectId)}/rows`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(rowsResp.ok()).toBeTruthy();
    const rowsJson = await rowsResp.json();
    expect(Array.isArray(rowsJson.rows)).toBeTruthy();
    expect(rowsJson.rows.length).toBeGreaterThan(0);
    const rowId = rowsJson.rows[0].rowId;
    expect(rowId).toBeTruthy();

    const workId = String(Date.now());
    const createSourceResp = await request.post(
      `${PUBLIC_API}/projects/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(rowId)}/create-source`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        data: { workId }
      }
    );
    expect(createSourceResp.ok()).toBeTruthy();
    const created = await createSourceResp.json();
    expect(created.workId).toBe(workId);
    expect(created.sourceId).toBeTruthy();

    await page.reload();
    const openSourceLink = page.getByRole('link', { name: 'Open Source' }).first();
    await expect(openSourceLink).toBeVisible({ timeout: 15000 });
    await openSourceLink.click();

    await page.waitForURL(new RegExp(`/works/${workId}`));
    await expect(page.getByText('Project').first()).toBeVisible({ timeout: 15000 });
  });
});
