// @ts-check
const { test, expect } = require('@playwright/test');
const { createHmac } = require('crypto');
const { MongoClient } = require('mongodb');

const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

function buildMongoUrl() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '..', '.env');
  const envFile = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const envMap = {};
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    envMap[key] = value;
  }
  const mongoUser = process.env.MONGO_INITDB_ROOT_USERNAME || envMap.MONGO_INITDB_ROOT_USERNAME || 'ots';
  const mongoPass = process.env.MONGO_INITDB_ROOT_PASSWORD || envMap.MONGO_INITDB_ROOT_PASSWORD || 'change_me';
  const mongoHost = process.env.MONGO_HOST || 'localhost';
  const mongoPort = process.env.MONGO_PORT || '27018';
  const mongoDb = process.env.MONGO_DB || 'ourtextscores';
  return `mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/${mongoDb}?authSource=admin`;
}

const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const makeJwt = (sub, email, sec) => {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub, email, iat: now, exp: now + 36000 })));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', sec).update(data).digest());
  return `${data}.${sig}`;
};

test.describe('DMCA lifecycle', () => {
  test.setTimeout(180000);

  let workId;
  let sourceId;
  let caseId;
  let adminUserId;
  let adminEmail;
  let adminToken;
  const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';

  test.beforeAll(async ({ request }) => {
    adminEmail = `dmca-admin-${Date.now()}@test.com`;

    const client = new MongoClient(buildMongoUrl());
    await client.connect();
    const db = client.db('ourtextscores');
    const inserted = await db.collection('users').insertOne({
      email: adminEmail,
      displayName: 'DMCA Admin',
      roles: ['admin'],
      status: 'active',
      enforcementStrikes: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    adminUserId = String(inserted.insertedId);
    await client.close();

    adminToken = makeJwt(adminUserId, adminEmail, secret);

    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const withSources = works.find((w) => (w.sourceCount || 0) > 0) || works[0];
    expect(withSources).toBeTruthy();
    workId = withSources.workId;

    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const source = (detail.sources || [])[0];
    expect(source).toBeTruthy();
    sourceId = source.sourceId;
  });

  test.afterAll(async () => {
    const client = new MongoClient(buildMongoUrl());
    await client.connect();
    const db = client.db('ourtextscores');
    await db.collection('users').deleteMany({ email: adminEmail }).catch(() => {});
    await client.close();
  });

  test('notice -> withhold -> metrics -> restore', async ({ request }) => {
    let restored = false;
    const noticeResp = await request.post(`${PUBLIC_API}/legal/dmca/notices`, {
      data: {
        workId,
        sourceId,
        complainantName: 'Smoke Test Complainant',
        complainantEmail: 'complainant@example.test',
        claimedWork: 'Smoke test claim',
        infringementStatement: 'This is a smoke test for lifecycle coverage.',
        goodFaithStatement: true,
        perjuryStatement: true,
        signature: 'Smoke Tester'
      }
    });
    expect(noticeResp.ok()).toBeTruthy();
    const noticeJson = await noticeResp.json();
    caseId = noticeJson.caseId;
    expect(caseId).toBeTruthy();

    try {
      const withholdResp = await request.post(
        `${PUBLIC_API}/legal/dmca/cases/${encodeURIComponent(caseId)}/withhold`,
        {
          data: { reason: 'Smoke test temporary withhold' },
          headers: { Authorization: `Bearer ${adminToken}` }
        }
      );
      expect(withholdResp.ok()).toBeTruthy();
      const withholdJson = await withholdResp.json();
      expect(withholdJson.status).toBe('content_disabled');

      const publicDetailAfterWithhold = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
      expect(publicDetailAfterWithhold.ok()).toBeTruthy();
      const hiddenDetail = await publicDetailAfterWithhold.json();
      const hiddenSource = (hiddenDetail.sources || []).find((s) => s.sourceId === sourceId);
      expect(hiddenSource).toBeFalsy();

      const metricsResp = await request.get(`${PUBLIC_API}/legal/dmca/metrics?days=365`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(metricsResp.ok()).toBeTruthy();
      const metrics = await metricsResp.json();
      expect(metrics.noticesReceived).toBeGreaterThan(0);
      expect(metrics.disabledCases).toBeGreaterThan(0);

      const restoreResp = await request.post(
        `${PUBLIC_API}/legal/dmca/cases/${encodeURIComponent(caseId)}/restore`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(restoreResp.ok()).toBeTruthy();
      const restoreJson = await restoreResp.json();
      expect(restoreJson.status).toBe('restored');
      restored = true;

      const publicDetailAfterRestore = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
      expect(publicDetailAfterRestore.ok()).toBeTruthy();
      const restoredDetail = await publicDetailAfterRestore.json();
      const restoredSource = (restoredDetail.sources || []).find((s) => s.sourceId === sourceId);
      expect(restoredSource).toBeTruthy();

      const caseResp = await request.get(`${PUBLIC_API}/legal/dmca/cases/${encodeURIComponent(caseId)}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(caseResp.ok()).toBeTruthy();
      const caseDetail = await caseResp.json();
      expect(caseDetail.status).toBe('restored');
      expect(Array.isArray(caseDetail.actions)).toBeTruthy();
      expect(caseDetail.actions.some((a) => a.actionType === 'content_withheld')).toBeTruthy();
      expect(caseDetail.actions.some((a) => a.actionType === 'content_restored')).toBeTruthy();
    } finally {
      if (caseId && !restored) {
        await request.post(`${PUBLIC_API}/legal/dmca/cases/${encodeURIComponent(caseId)}/restore`, {
          headers: { Authorization: `Bearer ${adminToken}` }
        }).catch(() => {});
      }
    }
  });
});
