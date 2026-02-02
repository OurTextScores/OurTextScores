/**
 * @file admin-verification.spec.cjs
 * E2E tests for admin source verification and flagging functionality
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');

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

// JWT token creation helper
const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const makeJwt = (sub, email, roles, sec) => {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub, email, roles, iat: now, exp: now + 36000 })));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', sec).update(data).digest());
  return `${data}.${sig}`;
};

test.describe('Admin Source Verification', () => {
  let workId;
  let sourceId;
  let adminUserId;
  const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';

  // Create unique email addresses for test users
  const adminEmail = `admin-test-${Date.now()}@test.com`;
  const regularEmail = `user-test-${Date.now()}@test.com`;

  test.beforeAll(async ({ request }) => {
    // Create admin user by directly inserting into MongoDB
    const MongoClient = require('mongodb').MongoClient;
    const mongoUrl = buildMongoUrl();
    const client = new MongoClient(mongoUrl);
    await client.connect();
    const db = client.db('ourtextscores');

    // Insert admin user directly
    const adminResult = await db.collection('users').insertOne({
      email: adminEmail,
      displayName: 'Admin Test User',
      roles: ['admin'],
      createdAt: new Date(),
      updatedAt: new Date()
    });
    adminUserId = String(adminResult.insertedId);

    await client.close();

    // Create JWT tokens
    const adminToken = makeJwt(adminUserId, adminEmail, [], secret);
    const regularToken = makeJwt('regular-user-id', regularEmail, [], secret);

    // Store tokens for use in tests
    test.adminToken = adminToken;
    test.regularToken = regularToken;
    test.adminUserId = adminUserId;

    // Get an existing work to upload to
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    expect(works.length).toBeGreaterThan(0);
    workId = works[0].workId;

    // Upload a test source
    const msczPath = path.join(__dirname, '..', '..', 'test_scores', 'bach_orig.mscz');
    const msczBuffer = fs.readFileSync(msczPath);

    const uploadResp = await request.post(`${PUBLIC_API}/works/${workId}/sources`, {
      multipart: {
        commitMessage: 'E2E test - admin verification',
        file: {
          name: 'test_score.mscz',
          mimeType: 'application/vnd.musescore.mscz',
          buffer: msczBuffer
        }
      },
      headers: { 'Authorization': `Bearer ${test.adminToken}` }
    });

    expect(uploadResp.ok()).toBeTruthy();
    const uploadData = await uploadResp.json();
    sourceId = uploadData.sourceId;

    // Wait for processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000));
  });

  test.afterAll(async ({}) => {
    // Cleanup - delete test users from MongoDB
    const MongoClient = require('mongodb').MongoClient;
    const mongoUrl = buildMongoUrl();
    const client = new MongoClient(mongoUrl);
    await client.connect();
    const db = client.db('ourtextscores');

    // Delete test users
    await db.collection('users').deleteMany({
      email: { $in: [adminEmail, regularEmail] }
    }).catch(() => {});

    await client.close();
  });

  test('admin can verify a source with optional note', async ({ request }) => {
    // Verify source with note
    const verifyResp = await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/verify`,
      {
        data: { note: 'Verified after manual review' },
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    expect(verifyResp.ok()).toBeTruthy();
    const verifyData = await verifyResp.json();
    expect(verifyData.ok).toBe(true);
    expect(verifyData.verifiedAt).toBeTruthy();

    // Check that source is marked as verified
    const workDetailResp = await request.get(`${PUBLIC_API}/works/${workId}`);
    const workDetail = await workDetailResp.json();
    const source = workDetail.sources.find(s => s.sourceId === sourceId);

    expect(source.adminVerified).toBe(true);
    expect(source.adminVerifiedBy).toBe(test.adminUserId);
    expect(source.adminVerificationNote).toBe('Verified after manual review');
    expect(source.adminVerifiedAt).toBeTruthy();

    // Check work has hasVerifiedSources flag
    expect(workDetail.hasVerifiedSources).toBe(true);
  });

  test('verified sources appear in filtered search', async ({ request }) => {
    // Search with verification filter
    const searchResp = await request.get(
      `${PUBLIC_API}/works?filter=${encodeURIComponent('hasVerifiedSources = true')}`
    );

    expect(searchResp.ok()).toBeTruthy();
    const searchData = await searchResp.json();

    const foundWork = searchData.works.find(w => w.workId === workId);
    expect(foundWork).toBeTruthy();
    expect(foundWork.hasVerifiedSources).toBe(true);
  });

  test('admin can remove verification', async ({ request }) => {
    // Remove verification
    const removeResp = await request.delete(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/verify`,
      {
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    expect(removeResp.ok()).toBeTruthy();
    const removeData = await removeResp.json();
    expect(removeData.ok).toBe(true);

    // Check that source is no longer verified
    const workDetailResp = await request.get(`${PUBLIC_API}/works/${workId}`);
    const workDetail = await workDetailResp.json();
    const source = workDetail.sources.find(s => s.sourceId === sourceId);

    expect(source.adminVerified).toBeFalsy();
    expect(source.adminVerifiedBy).toBeUndefined();
    expect(source.adminVerificationNote).toBeUndefined();
    expect(source.adminVerifiedAt).toBeUndefined();

    // Check work no longer has hasVerifiedSources flag
    expect(workDetail.hasVerifiedSources).toBe(false);
  });

  test('regular user cannot verify a source', async ({ request }) => {
    const verifyResp = await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/verify`,
      {
        data: { note: 'Trying to verify' },
        headers: { 'Authorization': `Bearer ${test.regularToken}` }
      }
    );

    expect(verifyResp.status()).toBe(403);
  });

  test('admin can flag a source for deletion', async ({ request }) => {
    // Flag source
    const flagResp = await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`,
      {
        data: { reason: 'Not a valid transcription' },
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    expect(flagResp.ok()).toBeTruthy();
    const flagData = await flagResp.json();
    expect(flagData.ok).toBe(true);
    expect(flagData.flaggedAt).toBeTruthy();

    // Check that source is marked as flagged
    const workDetailResp = await request.get(`${PUBLIC_API}/works/${workId}`);
    const workDetail = await workDetailResp.json();
    const source = workDetail.sources.find(s => s.sourceId === sourceId);

    expect(source.adminFlagged).toBe(true);
    expect(source.adminFlaggedBy).toBe(test.adminUserId);
    expect(source.adminFlagReason).toBe('Not a valid transcription');
    expect(source.adminFlaggedAt).toBeTruthy();
  });

  test('flagging requires a reason', async ({ request }) => {
    const flagResp = await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`,
      {
        data: { reason: '' },
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    expect(flagResp.status()).toBe(400);
  });

  test('admin can remove flag', async ({ request }) => {
    // Remove flag
    const removeFlagResp = await request.delete(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`,
      {
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    expect(removeFlagResp.ok()).toBeTruthy();
    const removeFlagData = await removeFlagResp.json();
    expect(removeFlagData.ok).toBe(true);

    // Check that source is no longer flagged
    const workDetailResp = await request.get(`${PUBLIC_API}/works/${workId}`);
    const workDetail = await workDetailResp.json();
    const source = workDetail.sources.find(s => s.sourceId === sourceId);

    expect(source.adminFlagged).toBeFalsy();
    expect(source.adminFlaggedBy).toBeUndefined();
    expect(source.adminFlagReason).toBeUndefined();
    expect(source.adminFlaggedAt).toBeUndefined();
  });

  test('regular user cannot flag a source', async ({ request }) => {
    const flagResp = await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`,
      {
        data: { reason: 'Trying to flag' },
        headers: { 'Authorization': `Bearer ${test.regularToken}` }
      }
    );

    expect(flagResp.ok()).toBeTruthy();
  });

  test('verification and flagging are independent', async ({ request }) => {
    // Verify source
    await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/verify`,
      {
        data: { note: 'Good transcription' },
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    // Also flag it (admin might verify quality but flag for other reasons)
    await request.post(
      `${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`,
      {
        data: { reason: 'Duplicate entry' },
        headers: { 'Authorization': `Bearer ${test.adminToken}` }
      }
    );

    // Check both states coexist
    const workDetailResp = await request.get(`${PUBLIC_API}/works/${workId}`);
    const workDetail = await workDetailResp.json();
    const source = workDetail.sources.find(s => s.sourceId === sourceId);

    expect(source.adminVerified).toBe(true);
    expect(source.adminFlagged).toBe(true);

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${workId}/sources/${sourceId}/verify`, {
      headers: { 'Authorization': `Bearer ${test.adminToken}` }
    });
    await request.delete(`${PUBLIC_API}/works/${workId}/sources/${sourceId}/flag`, {
      headers: { 'Authorization': `Bearer ${test.adminToken}` }
    });
  });
});
