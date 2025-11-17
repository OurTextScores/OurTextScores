// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

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

test.describe('Source Labeling', () => {
  test('upload source with label and edit it', async ({ page, request }) => {
    const email = `sourcelabel_${Date.now()}@example.test`;
    const sourceLabel = `Piano Score ${Date.now()}`;
    const sourceDescription = 'Full piano arrangement';
    const updatedLabel = `Vocal Parts ${Date.now()}`;
    const updatedDescription = 'Updated description for vocal parts';

    // Sign in via email
    await signInViaEmail(page, request, email);

    // Get a work from the API
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works[0];
    expect(work).toBeTruthy();

    // Go to work detail
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Find the upload form
    await expect(page.locator('h2:has-text("Upload a new source")')).toBeVisible();

    // Fill in source title
    const labelInput = page.locator('input[placeholder*="source title"]');
    await expect(labelInput).toBeVisible();
    await labelInput.fill(sourceLabel);

    // Fill in description
    const descriptionInput = page.locator('input[placeholder*="description"]').first();
    await descriptionInput.fill(sourceDescription);

    const fileInput = page.locator('section:has-text("Upload a new source") input[type="file"]').first();
    await expect(fileInput).toBeVisible();

    // Upload a real MuseScore test file
    const testFilePath = path.resolve(__dirname, '..', '..', 'test_scores', 'bach_orig.mscz');
    await fileInput.setInputFiles(testFilePath);

    const uploadButton = page.locator('button:has-text("Upload new source")').first();
    await uploadButton.click();

    // Wait for upload and processing to complete
    await expect(page.locator('text=Source uploaded.')).toBeVisible({ timeout: 120000 });

    // Verify the new source appears with the given label
    const newSourceHeading = page.locator('h2', { hasText: sourceLabel });
    await expect(newSourceHeading).toBeVisible({ timeout: 60000 });

    // Note: In a full e2e environment, we would:
    // 1. Upload a file using fileInput.setInputFiles('path/to/test.mscz')
    // 2. Wait for processing
    // 3. Verify the label appears in the source card
    // 4. Click edit button
    // 5. Update label and description
    // 6. Verify the updates appear

    // Verify the edit functionality exists on existing sources
    const editButtons = page.locator('button:has-text("Edit title/description")');
    const editCount = await editButtons.count();

    if (editCount > 0) {
      // Click the first edit button
      await editButtons.first().click();

      // Verify the edit form appears
      await expect(page.locator('label:has-text("Source Title")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('label:has-text("Description")')).toBeVisible();

      // Find the inputs in the edit form
      const editLabelInput = page.locator('input[placeholder*="Piano Score, Vocal Parts"]');
      const editDescInput = page.locator('textarea[placeholder*="Additional details"]');

      await expect(editLabelInput).toBeVisible();
      await expect(editDescInput).toBeVisible();

      // Fill in new values
      await editLabelInput.fill(updatedLabel);
      await editDescInput.fill(updatedDescription);

      // Click Save button
      const saveButton = page.locator('button:has-text("Save")').first();
      await saveButton.click();

      // Wait for the "Saved." message
      await expect(page.locator('text=Saved.')).toBeVisible({ timeout: 10000 });

      // Verify the form closed (edit button should be visible again)
      await expect(page.locator('button:has-text("Edit title/description")').first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('upload form shows source title field', async ({ page, request }) => {
    const email = `sourcelabel2_${Date.now()}@example.test`;

    // Sign in via email
    await signInViaEmail(page, request, email);

    // Get a work from the API
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works[0];
    expect(work).toBeTruthy();

    // Go to work detail
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Verify upload form has source title input
    await expect(page.locator('h2:has-text("Upload a new source")')).toBeVisible();
    const sourceTitleInput = page.locator('input[placeholder*="source title"]');
    await expect(sourceTitleInput).toBeVisible();

    // Verify it's optional (placeholder should indicate optional)
    const placeholder = await sourceTitleInput.getAttribute('placeholder');
    expect(placeholder).toContain('optional');
  });

  test('edit source form has cancel button', async ({ page, request }) => {
    const email = `sourcelabel3_${Date.now()}@example.test`;

    // Sign in via email
    await signInViaEmail(page, request, email);

    // Get a work with sources
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works.find((w) => w.sourceCount && w.sourceCount > 0);

    if (!work) {
      console.log('No works with sources found, skipping test');
      return;
    }

    // Go to work detail
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

    // Find and click edit button
    const editButtons = page.locator('button:has-text("Edit title/description")');
    const editCount = await editButtons.count();

    if (editCount > 0) {
      await editButtons.first().click();

      // Verify cancel button exists
      const cancelButton = page.locator('button:has-text("Cancel")').first();
      await expect(cancelButton).toBeVisible({ timeout: 5000 });

      // Click cancel and verify form closes
      await cancelButton.click();

      // Edit button should be visible again
      await expect(editButtons.first()).toBeVisible({ timeout: 2000 });
    }
  });
});
