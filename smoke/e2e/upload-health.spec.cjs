// @ts-check
const { test, expect } = require('@playwright/test');
const { MongoClient } = require('mongodb');
const { createHmac, randomUUID } = require('node:crypto');
const path = require('node:path');
const { encode } = require(require.resolve('next-auth/jwt', { paths: [path.resolve(__dirname, '../../frontend')] }));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = process.env.PUBLIC_API || 'http://localhost:4000/api';
const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';

test('admin sees upload failures and can reset only the chosen account', async ({ page, request }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(BASE).hostname), 'Use an isolated local smoke stack');
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://ots:change_me@localhost:27018/ourtextscores?authSource=admin');
  await client.connect();
  const db = client.db();
  const email = `upload-admin-${Date.now()}@example.test`;
  const user = await db.collection('users').insertOne({ email, roles: ['admin'], status: 'active' });
  const token = await encode({ token: { sub: String(user.insertedId), email, name: 'Upload operator' }, secret, maxAge: 3600 });
  await page.context().addCookies([{ name: 'next-auth.session-token', value: token, url: BASE }]);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: String(user.insertedId), email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const data = `${header}.${payload}`;
  const bearer = `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
  const auth = { Authorization: `Bearer ${bearer}` };
  try {
    // Exercise real observation ingestion and middleware rejections without
    // importing a score, contacting IMSLP, or writing object storage.
    const observation = await request.post(`${API}/operations/upload-observations`, { headers: auth, data: { attemptId: randomUUID(), status: 413, operation: 'project', durationMs: 25 } });
    expect(observation.ok()).toBeTruthy();
    const badUpload = await request.post(`${API}/projects/not-a-project/sources`, { headers: auth, multipart: { label: 'Missing file smoke check' } });
    expect(badUpload.status()).toBe(400);
    const denied = await request.get(`${API}/operations/uploads`);
    expect(denied.status()).toBe(401);
    const ordinaryEmail = `upload-user-${Date.now()}@example.test`;
    await db.collection('users').insertOne({ email: ordinaryEmail, roles: ['user'], status: 'active' });
    const ordinaryPayload = Buffer.from(JSON.stringify({ sub: ordinaryEmail, email: ordinaryEmail, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const ordinaryData = `${header}.${ordinaryPayload}`;
    const ordinaryBearer = `${ordinaryData}.${createHmac('sha256', secret).update(ordinaryData).digest('base64url')}`;
    const ordinaryAuth = { Authorization: `Bearer ${ordinaryBearer}` };
    expect((await request.get(`${API}/operations/uploads`, { headers: ordinaryAuth })).status()).toBe(403);
    expect((await request.post(`${API}/operations/upload-limits`, { headers: ordinaryAuth, data: { account: email, action: 'reset', reason: 'Should be forbidden' } })).status()).toBe(403);
    await page.goto(`${BASE}/admin/analytics`);
    await expect(page.getByRole('heading', { name: 'Upload health', exact: true })).toBeVisible();
    await expect(page.locator('td').filter({ hasText: 'payload_too_large' }).first()).toBeVisible({ timeout: 30000 });
    await page.getByText('Account upload limits and audit history').click();
    await page.getByLabel('Email or username').fill(email);
    await page.getByRole('button', { name: 'Look up account' }).click();
    await expect(page.getByText(/1 requests this window/)).toBeVisible();
    await page.getByLabel('Reason for change').fill('Scoped reset smoke verification');
    await page.getByRole('button', { name: 'Reset this account', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('counter was reset');
    await page.getByRole('button', { name: 'Grant temporary allowance', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('allowance is active');
    await page.getByRole('button', { name: 'Revoke allowance', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('allowance was revoked');
    const audit = await db.collection('upload_limit_audit').findOne({ userId: String(user.insertedId), action: 'reset' });
    expect(audit?.actorId).toBe(String(user.insertedId));
  } finally { await client.close(); }
});
