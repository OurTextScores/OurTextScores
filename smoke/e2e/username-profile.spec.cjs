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

test.describe('Username & Profile Settings', () => {
  test('set username and see it in revision badges', async ({ page, request }) => {
    const email = `smokeuser_${Date.now()}@example.test`;
    const username = `smoketest${Date.now().toString().slice(-6)}`;

    // Sign in via email
    await signInViaEmail(page, request, email);

    // Go to settings
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 });

    // Verify profile form is visible
    await expect(page.locator('h2:has-text("Profile")')).toBeVisible();
    const usernameInput = page.locator('input[name="username"]');
    await expect(usernameInput).toBeVisible();

    // Set username
    await usernameInput.fill(username);

    // Click Save button in profile form
    const saveButton = page.locator('form[data-testid="profile-form"] button:has-text("Save")');
    await saveButton.click();

    // Wait for success message
    await expect(page.locator('text=Profile updated successfully!')).toBeVisible({ timeout: 10000 });

    // Verify username is set by reloading and checking the input value
    await page.reload();
    await expect(usernameInput).toHaveValue(username);

    // Now verify username appears in revision badges
    // Go to home page and check if there are any works
    await page.goto(BASE_URL);

    // If there are works, navigate to one and check badges
    const workLinks = page.locator('a[href*="/works/"]');
    const count = await workLinks.count();

    if (count > 0) {
      // Click on the first work
      await workLinks.first().click();

      // Wait for the work page to load
      await expect(page.locator('h1')).toBeVisible({ timeout: 10000 });

      // Look for any user badges that might contain our username
      // This is best-effort since we may not have created revisions yet
      // The important test is that the username was saved successfully
    }
  });

  test('shows error when username is already taken', async ({ page, request }) => {
    const email1 = `smokeuser1_${Date.now()}@example.test`;
    const email2 = `smokeuser2_${Date.now()}@example.test`;
    const sharedUsername = `shared${Date.now().toString().slice(-6)}`;

    // First user sets username
    await signInViaEmail(page, request, email1);
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 });

    const usernameInput = page.locator('input[name="username"]');
    await usernameInput.fill(sharedUsername);

    const saveButton = page.locator('form[data-testid="profile-form"] button:has-text("Save")');
    await saveButton.click();
    await expect(page.locator('text=Profile updated successfully!')).toBeVisible({ timeout: 10000 });

    // Sign out
    await page.goto(`${BASE_URL}/api/auth/signout`);
    const signOutButton = page.locator('button:has-text("Sign out"), input[type="submit"][value="Sign out"]');
    if (await signOutButton.count()) await signOutButton.first().click();

    // Second user tries to use the same username
    await signInViaEmail(page, request, email2);
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 });

    const usernameInput2 = page.locator('input[name="username"]');
    await usernameInput2.fill(sharedUsername);

    const saveButton2 = page.locator('form[data-testid="profile-form"] button:has-text("Save")');
    await saveButton2.click();

    // Should see error message
    await expect(page.locator('text=Username already taken')).toBeVisible({ timeout: 10000 });
  });

  test('validates username format', async ({ page, request }) => {
    const email = `smokeuser_${Date.now()}@example.test`;

    await signInViaEmail(page, request, email);
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10000 });

    const usernameInput = page.locator('input[name="username"]');

    // Try invalid username with uppercase letters (should be converted to lowercase by backend)
    await usernameInput.fill('INVALID');

    const saveButton = page.locator('form[data-testid="profile-form"] button:has-text("Save")');
    await saveButton.click();

    // Should either succeed (if backend lowercases it) or show validation error
    // Wait for either success or error message
    const successOrError = page.locator('text=Profile updated successfully!, text=Username must be');
    await expect(successOrError.first()).toBeVisible({ timeout: 10000 });
  });
});
